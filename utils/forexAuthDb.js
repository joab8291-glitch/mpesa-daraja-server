const { Pool } = require("pg");

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
});

let schemaPromise;
async function ready() {
  if (!schemaPromise) {
    schemaPromise = pool.query(`
      CREATE TABLE IF NOT EXISTS forex_users (
        id UUID PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS forex_simulated_trades (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES forex_users(id) ON DELETE CASCADE,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL CHECK (side IN ('buy','sell')),
        quantity NUMERIC NOT NULL CHECK (quantity > 0),
        entry_price NUMERIC NOT NULL CHECK (entry_price > 0),
        stop_loss NUMERIC,
        take_profit NUMERIC,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
        exit_price NUMERIC,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        closed_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS forex_simulated_trades_user_created_idx
        ON forex_simulated_trades(user_id, created_at DESC);
    `).catch((error) => { schemaPromise = null; throw error; });
  }
  await schemaPromise;
}

async function createUser({ id, email, displayName, passwordHash, passwordSalt }) {
  await ready();
  const { rows } = await pool.query(
    `INSERT INTO forex_users (id,email,display_name,password_hash,password_salt)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING id,email,display_name,created_at`,
    [id,email,displayName,passwordHash,passwordSalt]
  );
  return rows[0];
}

async function findUserByEmail(email) {
  await ready();
  const { rows } = await pool.query(
    "SELECT id,email,display_name,password_hash,password_salt,created_at FROM forex_users WHERE email=$1 LIMIT 1",
    [email]
  );
  return rows[0] || null;
}

async function findUserById(id) {
  await ready();
  const { rows } = await pool.query(
    "SELECT id,email,display_name,created_at FROM forex_users WHERE id=$1 LIMIT 1",
    [id]
  );
  return rows[0] || null;
}

async function listTrades(userId) {
  await ready();
  const { rows } = await pool.query(
    `SELECT id, user_id AS "userId", symbol, side, quantity, entry_price AS "entryPrice",
            stop_loss AS "stopLoss", take_profit AS "takeProfit", status,
            exit_price AS "exitPrice", created_at AS "createdAt"
     FROM forex_simulated_trades WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100`,
    [userId]
  );
  return rows;
}

async function createTrade(userId, trade) {
  await ready();
  const { rows } = await pool.query(
    `INSERT INTO forex_simulated_trades
      (id,user_id,symbol,side,quantity,entry_price,stop_loss,take_profit,status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open')
     RETURNING id, user_id AS "userId", symbol, side, quantity, entry_price AS "entryPrice",
       stop_loss AS "stopLoss", take_profit AS "takeProfit", status,
       exit_price AS "exitPrice", created_at AS "createdAt"`,
    [require("crypto").randomUUID(), userId, trade.symbol, trade.side, trade.quantity,
      trade.entryPrice, trade.stopLoss, trade.takeProfit]
  );
  return rows[0];
}

async function closeTrade(userId, id, exitPrice) {
  await ready();
  const { rows } = await pool.query(
    `UPDATE forex_simulated_trades SET status='closed', exit_price=$3, closed_at=NOW()
     WHERE id=$1 AND user_id=$2 AND status='open'
     RETURNING id, user_id AS "userId", symbol, side, quantity, entry_price AS "entryPrice",
       stop_loss AS "stopLoss", take_profit AS "takeProfit", status,
       exit_price AS "exitPrice", created_at AS "createdAt"`,
    [id,userId,exitPrice]
  );
  return rows[0] || null;
}

module.exports = { createUser, findUserByEmail, findUserById, listTrades, createTrade, closeTrade };
