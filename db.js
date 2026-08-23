const Database = require("better-sqlite3");
const path = require("path");

const db = new Database(path.join(__dirname, "transactions.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    receipt TEXT UNIQUE,
    phone TEXT NOT NULL,
    amount REAL NOT NULL,
    delivered_amount REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    failure_reason TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

// Migration safety net: if this table already existed from before delivered_amount
// was introduced, add the column now. Fails silently if it's already there.
try {
  db.exec(`ALTER TABLE transactions ADD COLUMN delivered_amount REAL NOT NULL DEFAULT 0`);
  console.log("Migrated: added delivered_amount column");
} catch (e) {
  // Column already exists — expected on every run after the first migration
}

function receiptExists(receipt) {
  const row = db.prepare("SELECT id FROM transactions WHERE receipt = ?").get(receipt);
  return !!row;
}

module.exports = { db, receiptExists };