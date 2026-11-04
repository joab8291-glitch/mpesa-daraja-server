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
      CREATE TABLE IF NOT EXISTS forex_paper_accounts (
        user_id UUID PRIMARY KEY REFERENCES forex_users(id) ON DELETE CASCADE,
        balance_usd NUMERIC(18,2) NOT NULL DEFAULT 100000 CHECK (balance_usd >= 0),
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
        margin_required NUMERIC(18,2) NOT NULL DEFAULT 0,
        realized_pnl_usd NUMERIC(18,2),
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
        exit_price NUMERIC,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        closed_at TIMESTAMPTZ
      );
      ALTER TABLE forex_simulated_trades ADD COLUMN IF NOT EXISTS margin_required NUMERIC(18,2) NOT NULL DEFAULT 0;
      ALTER TABLE forex_simulated_trades ADD COLUMN IF NOT EXISTS realized_pnl_usd NUMERIC(18,2);
      CREATE TABLE IF NOT EXISTS forex_paper_ledger (
        id BIGSERIAL PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES forex_users(id) ON DELETE CASCADE,
        trade_id UUID NOT NULL UNIQUE REFERENCES forex_simulated_trades(id),
        amount_usd NUMERIC(18,2) NOT NULL,
        balance_after_usd NUMERIC(18,2) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
  await pool.query("INSERT INTO forex_paper_accounts (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING", [id]);
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
            stop_loss AS "stopLoss", take_profit AS "takeProfit",
            margin_required AS "marginRequired", realized_pnl_usd AS "realizedPnlUsd", status,
            exit_price AS "exitPrice", created_at AS "createdAt"
     FROM forex_simulated_trades WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100`,
    [userId]
  );
  return rows;
}

async function listOpenTrades() {
  await ready();
  const { rows } = await pool.query(
    `SELECT id, user_id AS "userId", symbol, side, quantity, entry_price AS "entryPrice",
      stop_loss AS "stopLoss", take_profit AS "takeProfit"
     FROM forex_simulated_trades WHERE status='open'`
  );
  return rows;
}

async function getPaperAccount(userId) {
  await ready();
  await pool.query("INSERT INTO forex_paper_accounts (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING", [userId]);
  const account = await pool.query("SELECT balance_usd FROM forex_paper_accounts WHERE user_id=$1", [userId]);
  const margin = await pool.query("SELECT COALESCE(SUM(margin_required),0) AS used FROM forex_simulated_trades WHERE user_id=$1 AND status='open'", [userId]);
  const balance = Number(account.rows[0].balance_usd);
  const usedMargin = Number(margin.rows[0].used);
  return { currency: "USD", balance, usedMargin, freeMargin: balance-usedMargin };
}

function pnlUsd({symbol,side,quantity,entryPrice,exitPrice}) {
  const direction = side === "buy" ? 1 : -1;
  const quotePnl = Number(quantity) * (Number(exitPrice)-Number(entryPrice)) * direction;
  const quote = symbol.split("/")[1];
  if (quote === "USD") return quotePnl;
  if (["JPY","CAD","CHF"].includes(quote)) return quotePnl / Number(exitPrice);
  throw new Error("Unsupported quote currency for USD account conversion");
}

async function createTrade(userId, trade) {
  await ready();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO forex_paper_accounts (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING", [userId]);
    const account = await client.query("SELECT balance_usd FROM forex_paper_accounts WHERE user_id=$1 FOR UPDATE", [userId]);
    const marginRows = await client.query("SELECT COALESCE(SUM(margin_required),0) AS used FROM forex_simulated_trades WHERE user_id=$1 AND status='open'", [userId]);
    const quote = trade.symbol.split("/")[1];
    const notionalUsd = quote === "USD" ? trade.quantity * trade.entryPrice : trade.quantity;
    const marginRequired = Math.round((notionalUsd / 100) * 100) / 100;
    const freeMargin = Number(account.rows[0].balance_usd) - Number(marginRows.rows[0].used);
    if (marginRequired > freeMargin) {
      const error = new Error("Insufficient free margin for this position.");
      error.code = "INSUFFICIENT_MARGIN";
      throw error;
    }
    const { rows } = await client.query(
      `INSERT INTO forex_simulated_trades
        (id,user_id,symbol,side,quantity,entry_price,stop_loss,take_profit,margin_required,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'open')
       RETURNING id, user_id AS "userId", symbol, side, quantity, entry_price AS "entryPrice",
         stop_loss AS "stopLoss", take_profit AS "takeProfit", margin_required AS "marginRequired",
         realized_pnl_usd AS "realizedPnlUsd", status, exit_price AS "exitPrice", created_at AS "createdAt"`,
      [require("crypto").randomUUID(), userId, trade.symbol, trade.side, trade.quantity,
        trade.entryPrice, trade.stopLoss, trade.takeProfit, marginRequired]
    );
    await client.query("COMMIT");
    return rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function closeTrade(userId, id, exitPrice) {
  await ready();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query("SELECT * FROM forex_simulated_trades WHERE id=$1 AND user_id=$2 AND status='open' FOR UPDATE", [id,userId]);
    const trade = found.rows[0];
    if (!trade) { await client.query("ROLLBACK"); return null; }
    const pnl = Math.round(pnlUsd({symbol:trade.symbol,side:trade.side,quantity:Number(trade.quantity),entryPrice:Number(trade.entry_price),exitPrice})*100)/100;
    await client.query("INSERT INTO forex_paper_accounts (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING", [userId]);
    const updated = await client.query(
      "UPDATE forex_paper_accounts SET balance_usd=GREATEST(0,balance_usd+$2), updated_at=NOW() WHERE user_id=$1 RETURNING balance_usd",
      [userId,pnl]
    );
    const { rows } = await client.query(
      `UPDATE forex_simulated_trades SET status='closed', exit_price=$3, realized_pnl_usd=$4, closed_at=NOW()
       WHERE id=$1 AND user_id=$2 AND status='open'
       RETURNING id, user_id AS "userId", symbol, side, quantity, entry_price AS "entryPrice",
         stop_loss AS "stopLoss", take_profit AS "takeProfit", margin_required AS "marginRequired",
         realized_pnl_usd AS "realizedPnlUsd", status, exit_price AS "exitPrice", created_at AS "createdAt"`,
      [id,userId,exitPrice,pnl]
    );
    await client.query(
      "INSERT INTO forex_paper_ledger (user_id,trade_id,amount_usd,balance_after_usd) VALUES ($1,$2,$3,$4)",
      [userId,id,pnl,updated.rows[0].balance_usd]
    );
    await client.query("COMMIT");
    return rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { createUser, findUserByEmail, findUserById, listTrades, createTrade, closeTrade, getPaperAccount, listOpenTrades };
