const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

let schemaPromise;
function ready() {
  if (!schemaPromise) {
    schemaPromise = pool.query(`
      CREATE TABLE IF NOT EXISTS forex_wallets (
        user_id TEXT PRIMARY KEY,
        balance_kes BIGINT NOT NULL DEFAULT 0 CHECK (balance_kes >= 0),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS forex_deposits (
        id UUID PRIMARY KEY,
        user_id TEXT NOT NULL,
        amount_kes BIGINT NOT NULL CHECK (amount_kes > 0),
        phone TEXT NOT NULL,
        merchant_request_id TEXT UNIQUE,
        checkout_request_id TEXT UNIQUE,
        mpesa_receipt TEXT UNIQUE,
        status TEXT NOT NULL DEFAULT 'initiating'
          CHECK (status IN ('initiating','pending','completed','failed')),
        failure_reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS forex_deposits_user_created_idx
        ON forex_deposits(user_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS forex_wallet_ledger (
        id BIGSERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        deposit_id UUID NOT NULL UNIQUE REFERENCES forex_deposits(id),
        mpesa_receipt TEXT NOT NULL UNIQUE,
        amount_kes BIGINT NOT NULL CHECK (amount_kes > 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `).catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}

async function createDeposit({ id, userId, amount, phone }) {
  await ready();
  await pool.query(
    `INSERT INTO forex_deposits (id, user_id, amount_kes, phone, status)
     VALUES ($1, $2, $3, $4, 'initiating')`,
    [id, userId, amount, phone]
  );
}

async function attachMpesaRequest({ id, merchantRequestId, checkoutRequestId }) {
  await ready();
  await pool.query(
    `UPDATE forex_deposits
     SET merchant_request_id = $2, checkout_request_id = $3,
         status = 'pending', updated_at = NOW()
     WHERE id = $1`,
    [id, merchantRequestId, checkoutRequestId]
  );
}

async function failDeposit(id, reason) {
  await ready();
  await pool.query(
    `UPDATE forex_deposits SET status = 'failed', failure_reason = $2,
       updated_at = NOW() WHERE id = $1 AND status = 'initiating'`,
    [id, String(reason || "STK Push could not be initiated").slice(0, 500)]
  );
}

async function findForexDepositByMerchant(merchantRequestId) {
  await ready();
  const { rows } = await pool.query(
    "SELECT * FROM forex_deposits WHERE merchant_request_id = $1 LIMIT 1",
    [merchantRequestId]
  );
  return rows[0] || null;
}

async function settleForexCallback({ merchantRequestId, resultCode, resultDesc, receipt, phone, amount }) {
  await ready();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query(
      "SELECT * FROM forex_deposits WHERE merchant_request_id = $1 FOR UPDATE",
      [merchantRequestId]
    );
    const deposit = found.rows[0];
    if (!deposit) {
      await client.query("ROLLBACK");
      return { handled: false };
    }

    if (Number(resultCode) !== 0) {
      if (deposit.status !== "completed") {
        await client.query(
          `UPDATE forex_deposits SET status = 'failed', failure_reason = $2,
             updated_at = NOW() WHERE id = $1`,
          [deposit.id, String(resultDesc || "M-Pesa payment failed").slice(0, 500)]
        );
      }
      await client.query("COMMIT");
      return { handled: true, status: "failed" };
    }

    if (!receipt || !phone || !Number.isFinite(Number(amount))) {
      throw new Error("Successful Forex callback is missing receipt, phone or amount");
    }
    if (Number(amount) !== Number(deposit.amount_kes) || String(phone) !== String(deposit.phone)) {
      throw new Error("Forex callback amount or phone does not match the original deposit");
    }

    if (deposit.status === "completed") {
      await client.query("COMMIT");
      return { handled: true, status: "completed", duplicate: true };
    }

    const duplicateReceipt = await client.query(
      "SELECT id FROM forex_deposits WHERE mpesa_receipt = $1 AND id <> $2",
      [receipt, deposit.id]
    );
    if (duplicateReceipt.rows.length) {
      throw new Error("M-Pesa receipt is already attached to another Forex deposit");
    }

    await client.query(
      `INSERT INTO forex_wallets (user_id, balance_kes)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO NOTHING`,
      [deposit.user_id, 0]
    );
    await client.query(
      `INSERT INTO forex_wallet_ledger (user_id, deposit_id, mpesa_receipt, amount_kes)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (deposit_id) DO NOTHING`,
      [deposit.user_id, deposit.id, receipt, deposit.amount_kes]
    );
    const ledger = await client.query(
      "SELECT id FROM forex_wallet_ledger WHERE deposit_id = $1",
      [deposit.id]
    );
    if (ledger.rows.length === 1) {
      const credited = await client.query(
        "SELECT balance_kes FROM forex_wallets WHERE user_id = $1 FOR UPDATE",
        [deposit.user_id]
      );
      const alreadyCredited = await client.query(
        "SELECT 1 FROM forex_wallet_ledger WHERE deposit_id = $1",
        [deposit.id]
      );
      // The unique ledger row is inserted once. Credit only if this transaction inserted it.
      const inserted = await client.query(
        "SELECT amount_kes FROM forex_wallet_ledger WHERE deposit_id = $1 AND created_at >= NOW() - INTERVAL '2 seconds'",
        [deposit.id]
      );
      if (inserted.rows.length && deposit.status !== "completed") {
        await client.query(
          "UPDATE forex_wallets SET balance_kes = balance_kes + $2, updated_at = NOW() WHERE user_id = $1",
          [deposit.user_id, deposit.amount_kes]
        );
      }
    }
    await client.query(
      `UPDATE forex_deposits SET status = 'completed', mpesa_receipt = $2,
         failure_reason = NULL, updated_at = NOW() WHERE id = $1`,
      [deposit.id, receipt]
    );
    await client.query("COMMIT");
    return { handled: true, status: "completed" };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function getWallet(userId) {
  await ready();
  const { rows } = await pool.query(
    "SELECT balance_kes FROM forex_wallets WHERE user_id = $1",
    [userId]
  );
  return Number(rows[0]?.balance_kes || 0);
}

async function getDepositForUser(merchantRequestId, userId) {
  await ready();
  const { rows } = await pool.query(
    `SELECT merchant_request_id, amount_kes, phone, status, mpesa_receipt,
            failure_reason, created_at, updated_at
     FROM forex_deposits
     WHERE merchant_request_id = $1 AND user_id = $2 LIMIT 1`,
    [merchantRequestId, userId]
  );
  return rows[0] || null;
}

module.exports = {
  createDeposit,
  attachMpesaRequest,
  failDeposit,
  findForexDepositByMerchant,
  settleForexCallback,
  getWallet,
  getDepositForUser,
};
