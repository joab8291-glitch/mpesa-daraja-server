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

const schemaReady = initSchema().catch((err) => {
  console.error("Failed to initialize transactions schema:", err);
  throw err;
});

async function receiptExists(receipt) {
  await schemaReady;
  const { rows } = await query("SELECT id FROM transactions WHERE receipt = $1", [receipt]);
  return rows.length > 0;
}

async function insertTransaction({ receipt, phone, amount, merchantRequestId, status, failureReason }) {
  await schemaReady;
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
  await schemaReady;
  const { rows } = await query(
    "SELECT * FROM transactions WHERE merchant_request_id = $1",
    [merchantRequestId]
  );
  return rows[0] || null;
}

async function getLatestByPhone(phone) {
  await schemaReady;
  const { rows } = await query(
    "SELECT * FROM transactions WHERE phone = $1 ORDER BY created_at DESC LIMIT 1",
    [phone]
  );
  return rows[0] || null;
}

async function getByReceipt(receipt) {
  await schemaReady;
  const { rows } = await query("SELECT * FROM transactions WHERE receipt = $1", [receipt]);
  return rows[0] || null;
}

async function getById(id) {
  await schemaReady;
  const { rows } = await query("SELECT * FROM transactions WHERE id = $1", [id]);
  return rows[0] || null;
}

async function listByStatuses(statuses) {
  await schemaReady;
  const { rows } = await query(
    `SELECT * FROM transactions WHERE status = ANY($1) ORDER BY created_at ASC`,
    [statuses]
  );
  return rows;
}

async function listAll(status) {
  await schemaReady;
  const { rows } = status
    ? await query(`SELECT * FROM transactions WHERE status = $1 ORDER BY created_at DESC`, [status])
    : await query(`SELECT * FROM transactions ORDER BY created_at DESC`);
  return rows;
}

async function updateDeliveredAmount(id, deliveredAmount) {
  await schemaReady;
  await query(
    `UPDATE transactions SET delivered_amount = $1, updated_at = NOW() WHERE id = $2`,
    [deliveredAmount, id]
  );
}

async function markCompleted(id) {
  await schemaReady;
  await query(`UPDATE transactions SET status = 'completed', updated_at = NOW() WHERE id = $1`, [id]);
}

async function markFailOrRetry(id, status, attempts, reason) {
  await schemaReady;
  await query(
    `UPDATE transactions SET status = $1, attempts = $2, failure_reason = $3, updated_at = NOW() WHERE id = $4`,
    [status, attempts, reason || null, id]
  );
}

async function markRequeue(id) {
  await schemaReady;
  await query(`UPDATE transactions SET status = 'pending', updated_at = NOW() WHERE id = $1`, [id]);
}

module.exports = {
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
