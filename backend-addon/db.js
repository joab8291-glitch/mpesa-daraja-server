/**
 * Agents + subscriptions storage for the Webazi backend
 * (webazi-digital-solutions.onrender.com).
 *
 * Uses better-sqlite3 (file-based, zero external DB service needed).
 * Drop this whole `backend-addon` folder's files into your existing
 * mpesa-daraja-server repo (or a subfolder of it) and wire up per
 * README-integration.md.
 *
 * ⚠️ Render free/starter web services have EPHEMERAL disks — the
 * sqlite file is wiped on every redeploy/restart. For real production
 * use, either (a) attach a Render Persistent Disk to this service and
 * point DB_PATH at a file inside it, or (b) swap this file for a
 * Postgres connection (Render's free Postgres works fine) — the
 * exported functions below are the only thing routes call, so you can
 * reimplement this one file against Postgres later without touching
 * agentsRoutes.js / adminRoutes.js.
 */

const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const DB_PATH = process.env.AGENTS_DB_PATH || path.join(__dirname, 'agents.db');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    notification_number TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    device_id TEXT,
    agent_key TEXT NOT NULL,
    build_variant TEXT NOT NULL DEFAULT 'agent',   -- 'agent' | 'free'
    is_free_access INTEGER NOT NULL DEFAULT 0,
    revoked INTEGER NOT NULL DEFAULT 0,
    first_login_at TEXT,
    subscription_end_date TEXT,
    last_paid_months INTEGER,
    last_paid_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    months INTEGER NOT NULL,
    method TEXT NOT NULL,          -- 'stk' | 'sambaza'
    reference TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}
function newId() {
  return crypto.randomBytes(12).toString('hex');
}
function newKey() {
  return crypto.randomBytes(24).toString('hex');
}

/** password comes in already sha256'd from the client (see mobile
 * services/agentBackend.ts) — we hash it again server-side so the
 * DB never stores something directly usable against the client hash. */
function hashClientPassword(clientHash) {
  return sha256('server-pepper:' + clientHash);
}

function normalizeNumber(n) {
  const digits = String(n).replace(/\D/g, '');
  return digits.slice(-9); // last 9 digits, matches app's last9Digits()
}

function computeSubscriptionEndDate(paidAtIso, months) {
  const paidAt = new Date(paidAtIso);
  const end = new Date(paidAt);
  end.setMonth(end.getMonth() + months, 1);
  end.setSeconds(paidAt.getSeconds(), paidAt.getMilliseconds());
  return end.toISOString();
}

function computeTrialEndDate(firstLoginAtIso) {
  return new Date(new Date(firstLoginAtIso).getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
}

function statusFor(agent) {
  if (agent.revoked) return 'revoked';
  if (agent.is_free_access) return 'free';
  const now = new Date();
  if (agent.subscription_end_date && now < new Date(agent.subscription_end_date)) return 'active';
  if (agent.first_login_at && now < new Date(computeTrialEndDate(agent.first_login_at))) return 'trial';
  return 'expired';
}

function toPublic(agent) {
  return {
    id: agent.id,
    notificationNumber: agent.notification_number,
    buildVariant: agent.build_variant,
    isFreeAccess: !!agent.is_free_access,
    revoked: !!agent.revoked,
    firstLoginAt: agent.first_login_at,
    trialEndsAt: agent.first_login_at ? computeTrialEndDate(agent.first_login_at) : null,
    subscriptionEndsAt: agent.subscription_end_date,
    lastPaidMonths: agent.last_paid_months,
    lastPaidAt: agent.last_paid_at,
    status: statusFor(agent),
    createdAt: agent.created_at,
    updatedAt: agent.updated_at,
  };
}

function findByNumber(notificationNumber) {
  return db
    .prepare('SELECT * FROM agents WHERE notification_number = ?')
    .get(normalizeNumber(notificationNumber));
}

function findById(id) {
  return db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
}

function registerAgent({ notificationNumber, passwordHashClient, deviceId, buildVariant }) {
  const existing = findByNumber(notificationNumber);
  if (existing) {
    const err = new Error('Notification number already registered');
    err.code = 'ALREADY_EXISTS';
    throw err;
  }
  const id = newId();
  const agentKey = newKey();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO agents (id, notification_number, password_hash, device_id, agent_key, build_variant, is_free_access, first_login_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    normalizeNumber(notificationNumber),
    hashClientPassword(passwordHashClient),
    deviceId || null,
    agentKey,
    buildVariant === 'free' ? 'free' : 'agent',
    buildVariant === 'free' ? 1 : 0,
    now,
    now,
    now
  );
  return { agent: toPublic(findById(id)), agentId: id, agentKey };
}

function loginAgent({ notificationNumber, passwordHashClient, deviceId }) {
  const row = findByNumber(notificationNumber);
  if (!row) {
    const err = new Error('No account for this number');
    err.code = 'NOT_FOUND';
    throw err;
  }
  if (row.password_hash !== hashClientPassword(passwordHashClient)) {
    const err = new Error('Incorrect password');
    err.code = 'BAD_PASSWORD';
    throw err;
  }
  // Single-device model: logging in from a new device replaces the
  // registered device (matches the app's one-phone-per-account design).
  // If you want stricter control (block instead of replace), change
  // this to compare row.device_id and throw when it differs.
  db.prepare(`UPDATE agents SET device_id = ?, updated_at = datetime('now') WHERE id = ?`).run(
    deviceId || row.device_id,
    row.id
  );
  return { agent: toPublic(findById(row.id)), agentId: row.id, agentKey: row.agent_key };
}

function getStatus(agentId, agentKey) {
  const row = findById(agentId);
  if (!row || row.agent_key !== agentKey) {
    const err = new Error('Not found');
    err.code = 'NOT_FOUND';
    throw err;
  }
  return toPublic(row);
}

function recordPayment(agentId, agentKey, { months, method, reference }) {
  const row = findById(agentId);
  if (!row || row.agent_key !== agentKey) {
    const err = new Error('Not found');
    err.code = 'NOT_FOUND';
    throw err;
  }
  const now = new Date().toISOString();
  const base =
    row.subscription_end_date && new Date(row.subscription_end_date) > new Date()
      ? row.subscription_end_date
      : now;
  const newEnd = computeSubscriptionEndDate(now, Number(months)); // per spec: anchored to payment moment, not stacked off old end
  db.prepare(
    `UPDATE agents SET subscription_end_date = ?, last_paid_months = ?, last_paid_at = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(newEnd, months, now, row.id);
  db.prepare(`INSERT INTO payments (agent_id, months, method, reference) VALUES (?, ?, ?, ?)`).run(
    row.id,
    months,
    method,
    reference || null
  );
  return toPublic(findById(row.id));
}

// ---- admin ----

function listAgents() {
  const rows = db.prepare('SELECT * FROM agents ORDER BY created_at DESC').all();
  return rows.map(toPublic);
}

function adminRevoke(agentId, revoked) {
  db.prepare(`UPDATE agents SET revoked = ?, updated_at = datetime('now') WHERE id = ?`).run(
    revoked ? 1 : 0,
    agentId
  );
  return toPublic(findById(agentId));
}

function adminSetFree(agentId, enabled) {
  db.prepare(`UPDATE agents SET is_free_access = ?, updated_at = datetime('now') WHERE id = ?`).run(
    enabled ? 1 : 0,
    agentId
  );
  return toPublic(findById(agentId));
}

function adminExtend(agentId, days) {
  const row = findById(agentId);
  const base =
    row.subscription_end_date && new Date(row.subscription_end_date) > new Date()
      ? new Date(row.subscription_end_date)
      : new Date();
  base.setDate(base.getDate() + Number(days));
  db.prepare(`UPDATE agents SET subscription_end_date = ?, updated_at = datetime('now') WHERE id = ?`).run(
    base.toISOString(),
    agentId
  );
  return toPublic(findById(agentId));
}

function adminDelete(agentId) {
  db.prepare('DELETE FROM agents WHERE id = ?').run(agentId);
  db.prepare('DELETE FROM payments WHERE agent_id = ?').run(agentId);
}

module.exports = {
  registerAgent,
  loginAgent,
  getStatus,
  recordPayment,
  listAgents,
  adminRevoke,
  adminSetFree,
  adminExtend,
  adminDelete,
  findById,
};
