/**
 * Agents + subscriptions storage for the Webazi backend
 * (webazi-digital-solutions.onrender.com).
 *
 * Postgres version (Supabase free tier) — replaces the original
 * better-sqlite3 file. Storage now survives Render redeploys since
 * it lives in Supabase, not on the service's ephemeral disk.
 *
 * Exported function names/shapes are unchanged from the SQLite
 * version EXCEPT every function is now async (returns a Promise),
 * because `pg` is non-blocking. agentsRoutes.js / adminRoutes.js have
 * been updated to `await` these calls.
 *
 * Setup:
 *   npm install pg
 *   npm uninstall better-sqlite3   (only if nothing else in this repo
 *                                    still uses it — check your root
 *                                    transactions db.js first)
 *   Set DATABASE_URL in Render's env vars to your Supabase connection
 *   string (Project Settings -> Database -> Connection string -> URI,
 *   "Connection pooling" version, port 6543).
 */

const { Pool } = require('pg');
const crypto = require('crypto');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set — add your Supabase connection string to env vars');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Supabase requires SSL; free tier uses a shared cert chain
});

async function query(text, params) {
  return pool.query(text, params);
}

async function initSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      notification_number TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      device_id TEXT,
      agent_key TEXT NOT NULL,
      build_variant TEXT NOT NULL DEFAULT 'agent',
      is_free_access BOOLEAN NOT NULL DEFAULT FALSE,
      revoked BOOLEAN NOT NULL DEFAULT FALSE,
      first_login_at TIMESTAMPTZ,
      subscription_end_date TIMESTAMPTZ,
      last_paid_months INTEGER,
      last_paid_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS payments (
      id SERIAL PRIMARY KEY,
      agent_id TEXT NOT NULL,
      months INTEGER NOT NULL,
      method TEXT NOT NULL,
      reference TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}
// Fire on module load; routes only run after require() resolves the
// module body, but queries below will queue on the pool until this
// completes since pg handles connection setup internally either way.
const schemaReady = initSchema().catch((err) => {
  console.error('Failed to initialize agents/payments schema:', err);
  throw err;
});

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

function toIso(d) {
  return d ? new Date(d).toISOString() : null;
}

function toPublic(agent) {
  return {
    id: agent.id,
    notificationNumber: agent.notification_number,
    buildVariant: agent.build_variant,
    isFreeAccess: !!agent.is_free_access,
    revoked: !!agent.revoked,
    firstLoginAt: toIso(agent.first_login_at),
    trialEndsAt: agent.first_login_at ? computeTrialEndDate(agent.first_login_at) : null,
    subscriptionEndsAt: toIso(agent.subscription_end_date),
    lastPaidMonths: agent.last_paid_months,
    lastPaidAt: toIso(agent.last_paid_at),
    status: statusFor(agent),
    createdAt: toIso(agent.created_at),
    updatedAt: toIso(agent.updated_at),
  };
}

async function findByNumber(notificationNumber) {
  await schemaReady;
  const { rows } = await query('SELECT * FROM agents WHERE notification_number = $1', [
    normalizeNumber(notificationNumber),
  ]);
  return rows[0] || null;
}

async function findById(id) {
  await schemaReady;
  const { rows } = await query('SELECT * FROM agents WHERE id = $1', [id]);
  return rows[0] || null;
}

async function registerAgent({ notificationNumber, passwordHashClient, deviceId, buildVariant }) {
  await schemaReady;
  const existing = await findByNumber(notificationNumber);
  if (existing) {
    const err = new Error('Notification number already registered');
    err.code = 'ALREADY_EXISTS';
    throw err;
  }
  const id = newId();
  const agentKey = newKey();
  const now = new Date().toISOString();
  try {
    await query(
      `INSERT INTO agents (id, notification_number, password_hash, device_id, agent_key, build_variant, is_free_access, first_login_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        id,
        normalizeNumber(notificationNumber),
        hashClientPassword(passwordHashClient),
        deviceId || null,
        agentKey,
        buildVariant === 'free' ? 'free' : 'agent',
        buildVariant === 'free',
        now,
        now,
        now,
      ]
    );
  } catch (e) {
    if (e.code === '23505') {
      // unique_violation — race with a concurrent register for the same number
      const err = new Error('Notification number already registered');
      err.code = 'ALREADY_EXISTS';
      throw err;
    }
    throw e;
  }
  return { agent: toPublic(await findById(id)), agentId: id, agentKey };
}

async function loginAgent({ notificationNumber, passwordHashClient, deviceId }) {
  await schemaReady;
  const row = await findByNumber(notificationNumber);
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
  await query(`UPDATE agents SET device_id = $1, updated_at = NOW() WHERE id = $2`, [
    deviceId || row.device_id,
    row.id,
  ]);
  return { agent: toPublic(await findById(row.id)), agentId: row.id, agentKey: row.agent_key };
}

async function getStatus(agentId, agentKey) {
  await schemaReady;
  const row = await findById(agentId);
  if (!row || row.agent_key !== agentKey) {
    const err = new Error('Not found');
    err.code = 'NOT_FOUND';
    throw err;
  }
  return toPublic(row);
}

async function recordPayment(agentId, agentKey, { months, method, reference }) {
  await schemaReady;
  const row = await findById(agentId);
  if (!row || row.agent_key !== agentKey) {
    const err = new Error('Not found');
    err.code = 'NOT_FOUND';
    throw err;
  }
  const now = new Date().toISOString();
  const newEnd = computeSubscriptionEndDate(now, Number(months)); // per spec: anchored to payment moment, not stacked off old end
  await query(
    `UPDATE agents SET subscription_end_date = $1, last_paid_months = $2, last_paid_at = $3, updated_at = NOW() WHERE id = $4`,
    [newEnd, months, now, row.id]
  );
  await query(`INSERT INTO payments (agent_id, months, method, reference) VALUES ($1, $2, $3, $4)`, [
    row.id,
    months,
    method,
    reference || null,
  ]);
  return toPublic(await findById(row.id));
}

// ---- admin ----

async function listAgents() {
  await schemaReady;
  const { rows } = await query('SELECT * FROM agents ORDER BY created_at DESC');
  return rows.map(toPublic);
}

async function adminRevoke(agentId, revoked) {
  await schemaReady;
  await query(`UPDATE agents SET revoked = $1, updated_at = NOW() WHERE id = $2`, [!!revoked, agentId]);
  return toPublic(await findById(agentId));
}

async function adminSetFree(agentId, enabled) {
  await schemaReady;
  await query(`UPDATE agents SET is_free_access = $1, updated_at = NOW() WHERE id = $2`, [!!enabled, agentId]);
  return toPublic(await findById(agentId));
}

async function adminExtend(agentId, days) {
  await schemaReady;
  const row = await findById(agentId);
  const base =
    row.subscription_end_date && new Date(row.subscription_end_date) > new Date()
      ? new Date(row.subscription_end_date)
      : new Date();
  base.setDate(base.getDate() + Number(days));
  await query(`UPDATE agents SET subscription_end_date = $1, updated_at = NOW() WHERE id = $2`, [
    base.toISOString(),
    agentId,
  ]);
  return toPublic(await findById(agentId));
}

async function adminDelete(agentId) {
  await schemaReady;
  await query('DELETE FROM payments WHERE agent_id = $1', [agentId]);
  await query('DELETE FROM agents WHERE id = $1', [agentId]);
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
