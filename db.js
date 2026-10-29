/**
 * Orders/transactions storage — Postgres (Supabase), not local SQLite.
 *
 * Render's free-plan disk is fully ephemeral: it's wiped on every
 * deploy/restart. The previous better-sqlite3 setup wrote to a local
 * transactions.db file on that disk, which is why a failed STK push
 * showed "status":"failed" correctly right after the callback, but
 * came back {"error":"Order not found"} the moment the service
 * redeployed — the file it was written to had already been wiped.
 *
 * This mirrors backend-addon/db.js, which made the same move for the
 * agents/payments tables for the exact same reason.
 */
const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set — add your Supabase connection string to env vars");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function query(text, params) {
  return pool.query(text, params);
}

async function initSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS stk_attempts (
      request_id TEXT PRIMARY KEY,
      phone TEXT NOT NULL,
      amount REAL NOT NULL,
      account_ref TEXT,
      status TEXT NOT NULL DEFAULT 'initiating',
      merchant_request_id TEXT UNIQUE,
      checkout_request_id TEXT UNIQUE,
      response_code TEXT,
      failure_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      receipt TEXT UNIQUE,
      phone TEXT NOT NULL,
      amount REAL NOT NULL,
      merchant_request_id TEXT,
      delivered_amount REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      failure_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  // Existing installs created this table before merchant_request_id/receipt
  // needed to coexist with NULL receipts on failed attempts — CREATE TABLE
  // IF NOT EXISTS won't add columns to an already-existing table, but since
  // this schema has been stable since the SQLite version, a fresh Supabase
  // database will always get the right shape from the statement above.
}

let schemaPromise = null;
function schemaReady() {
  if (!schemaPromise) {
    schemaPromise = initSchema().catch((err) => {
      console.error("Failed to initialize schema:", err.message);
      schemaPromise = null; // retry on next request
      throw err;
    });
  }
  return schemaPromise;
}

async function receiptExists(receipt) {
  await schemaReady();
  const { rows } = await query("SELECT id FROM transactions WHERE receipt = $1", [receipt]);
  return rows.length > 0;
}

async function insertTransaction({ receipt, phone, amount, merchantRequestId, status, failureReason }) {
  await schemaReady();
  await query(
    `INSERT INTO transactions (
      receipt, phone, amount, merchant_request_id,
      delivered_amount, status, attempts, failure_reason
    )
    VALUES ($1, $2, $3, $4, 0, $5, 0, $6)`,
    [receipt || null, phone, amount, merchantRequestId || null, status, failureReason || null]
  );
}

async function getByMerchantRequestId(merchantRequestId) {
  await schemaReady();
  const { rows } = await query(
    "SELECT * FROM transactions WHERE merchant_request_id = $1",
    [merchantRequestId]
  );
  return rows[0] || null;
}

async function getLatestByPhone(phone) {
  await schemaReady();
  const { rows } = await query(
    "SELECT * FROM transactions WHERE phone = $1 ORDER BY created_at DESC LIMIT 1",
    [phone]
  );
  return rows[0] || null;
}

async function getByReceipt(receipt) {
  await schemaReady();
  const { rows } = await query("SELECT * FROM transactions WHERE receipt = $1", [receipt]);
  return rows[0] || null;
}

async function getById(id) {
  await schemaReady();
  const { rows } = await query("SELECT * FROM transactions WHERE id = $1", [id]);
  return rows[0] || null;
}

async function listByStatuses(statuses) {
  await schemaReady();
  const { rows } = await query(
    `SELECT * FROM transactions WHERE status = ANY($1) ORDER BY created_at ASC`,
    [statuses]
  );
  return rows;
}

async function listAll(status) {
  await schemaReady();
  const { rows } = status
    ? await query(`SELECT * FROM transactions WHERE status = $1 ORDER BY created_at DESC`, [status])
    : await query(`SELECT * FROM transactions ORDER BY created_at DESC`);
  return rows;
}

async function updateDeliveredAmount(id, deliveredAmount) {
  await schemaReady();
  await query(
    `UPDATE transactions SET delivered_amount = $1, updated_at = NOW() WHERE id = $2`,
    [deliveredAmount, id]
  );
}

async function markCompleted(id) {
  await schemaReady();
  await query(`UPDATE transactions SET status = 'completed', updated_at = NOW() WHERE id = $1`, [id]);
}

async function markFailOrRetry(id, status, attempts, reason) {
  await schemaReady();
  await query(
    `UPDATE transactions SET status = $1, attempts = $2, failure_reason = $3, updated_at = NOW() WHERE id = $4`,
    [status, attempts, reason || null, id]
  );
}

async function markRequeue(id) {
  await schemaReady();
  await query(`UPDATE transactions SET status = 'pending', updated_at = NOW() WHERE id = $1`, [id]);
}

async function createStkAttempt({ requestId, phone, amount, accountRef }) {
  await schemaReady();
  const { rows } = await query(
    `INSERT INTO stk_attempts (request_id, phone, amount, account_ref, status)
     VALUES ($1, $2, $3, $4, 'initiating')
     ON CONFLICT (request_id) DO NOTHING
     RETURNING *`,
    [requestId, phone, amount, accountRef || null]
  );
  if (rows[0]) return { row: rows[0], created: true };
  const existing = await getStkAttemptByRequestId(requestId);
  return { row: existing, created: false };
}

async function getStkAttemptByRequestId(requestId) {
  await schemaReady();
  const { rows } = await query("SELECT * FROM stk_attempts WHERE request_id = $1", [requestId]);
  return rows[0] || null;
}

async function updateStkAttempt(requestId, patch = {}) {
  await schemaReady();
  const allowed = ["status", "merchant_request_id", "checkout_request_id", "response_code", "failure_reason"];
  const entries = Object.entries(patch).filter(([key, value]) => allowed.includes(key) && value !== undefined);
  if (!entries.length) return getStkAttemptByRequestId(requestId);
  const assignments = entries.map(([key], i) => `${key} = ${i + 2}`);
  assignments.push("updated_at = NOW()");
  const values = [requestId, ...entries.map(([, value]) => value)];
  const { rows } = await query(
    `UPDATE stk_attempts SET ${assignments.join(", ")} WHERE request_id = $1 RETURNING *`,
    values
  );
  return rows[0] || null;
}

async function updateStkAttemptByDarajaIds({ merchantRequestId, checkoutRequestId, patch }) {
  await schemaReady();
  if (!merchantRequestId && !checkoutRequestId) return null;
  const allowed = ["status", "response_code", "failure_reason"];
  const entries = Object.entries(patch || {}).filter(([key, value]) => allowed.includes(key) && value !== undefined);
  if (!entries.length) return null;
  const assignments = entries.map(([key], i) => `${key} = ${i + 3}`);
  assignments.push("updated_at = NOW()");
  const values = [merchantRequestId || null, checkoutRequestId || null, ...entries.map(([, value]) => value)];
  const { rows } = await query(
    `UPDATE stk_attempts SET ${assignments.join(", ")}
     WHERE (($1::text IS NOT NULL AND merchant_request_id = $1)
         OR ($2::text IS NOT NULL AND checkout_request_id = $2))
     RETURNING *`,
    values
  );
  return rows[0] || null;
}

module.exports = {
  createStkAttempt,
  getStkAttemptByRequestId,
  updateStkAttempt,
  updateStkAttemptByDarajaIds,
  receiptExists,
  insertTransaction,
  getByMerchantRequestId,
  getLatestByPhone,
  getByReceipt,
  getById,
  listByStatuses,
  listAll,
  updateDeliveredAmount,
  markCompleted,
  markFailOrRetry,
  markRequeue,
};
