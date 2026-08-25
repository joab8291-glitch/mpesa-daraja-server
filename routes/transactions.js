const express = require("express");
const { db } = require("../db");
const router = express.Router();

/**
 * Simple API key protection — same pattern as routes/stkPush.js
 * Expects header: x-api-key: YOUR_SECRET
 */
function checkApiKey(req, res, next) {
  const apiKey = process.env.API_KEY;

  // If no API_KEY is set in environment, allow all requests (dev mode)
  if (!apiKey) {
    return next();
  }

  const provided = req.headers["x-api-key"];

  if (!provided || provided !== apiKey) {
    return res.status(401).json({ error: "Unauthorized – invalid or missing API key" });
  }

  next();
}

// Apply API key check to all routes in this file
router.use(checkApiKey);

// NOTE: The Sambaza worker no longer polls this endpoint — it now reacts to
// the M-Pesa payment SMS it receives directly on the device. Left in place
// in case anything else still needs a full pending list.
router.get("/pending", (req, res) => {
  const rows = db
    .prepare(`
      SELECT *
      FROM transactions
      WHERE status IN ('pending', 'retry')
      ORDER BY created_at ASC
    `)
    .all();

  res.json(rows);
});

router.get("/", (req, res) => {
  const status = req.query.status;
  const rows = status
    ? db.prepare(`SELECT * FROM transactions WHERE status = ? ORDER BY created_at DESC`).all(status)
    : db.prepare(`SELECT * FROM transactions ORDER BY created_at DESC`).all();
  res.json(rows);
});

// NEW: lets the Sambaza worker find a transaction's id from the M-Pesa
// receipt number it reads out of the SMS notification, so it can still
// call /progress, /complete, /fail below without polling /pending first.
router.get("/by-receipt/:receipt", (req, res) => {
  const txn = db.prepare(`SELECT * FROM transactions WHERE receipt = ?`).get(req.params.receipt);

  if (!txn) {
    return res.status(404).json({ error: "No transaction found for that receipt" });
  }

  res.json(txn);
});

// NEW: called after EVERY successful Sambaza chunk — records cumulative progress
// so a retry never re-dials airtime that was already delivered.
router.post("/:id/progress", (req, res) => {
  const { deliveredAmount } = req.body || {};

  if (typeof deliveredAmount !== "number" || deliveredAmount < 0) {
    return res.status(400).json({ error: "deliveredAmount must be a non-negative number" });
  }

  const txn = db.prepare(`SELECT * FROM transactions WHERE id = ?`).get(req.params.id);
  if (!txn) return res.status(404).json({ error: "Transaction not found" });

  const newDelivered = Math.max(txn.delivered_amount, deliveredAmount);

  db.prepare(
    `UPDATE transactions SET delivered_amount = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(newDelivered, req.params.id);

  console.log(`Txn #${req.params.id}: progress ${newDelivered}/${txn.amount}`);
  res.json({ ok: true, delivered_amount: newDelivered });
});

router.post("/:id/complete", (req, res) => {
  // CHANGED: added the safety check below — was previously a straight UPDATE with no guard.
  const txn = db.prepare(`SELECT * FROM transactions WHERE id = ?`).get(req.params.id);
  if (!txn) return res.status(404).json({ error: "Transaction not found" });

  if (txn.delivered_amount < txn.amount) {
    return res.status(400).json({
      error: "Cannot complete — delivered_amount is less than amount",
      delivered_amount: txn.delivered_amount,
      amount: txn.amount,
    });
  }

  db.prepare(`UPDATE transactions SET status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

router.post("/:id/fail", (req, res) => {
  const { reason } = req.body || {};
  const txn = db.prepare(`SELECT * FROM transactions WHERE id = ?`).get(req.params.id);
  if (!txn) return res.status(404).json({ error: "Transaction not found" });

  const attempts = txn.attempts + 1;
  const newStatus = attempts >= 3 ? "failed" : "retry";

  db.prepare(
    `UPDATE transactions SET status = ?, attempts = ?, failure_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(newStatus, attempts, reason || null, req.params.id);

  // CHANGED: response now also includes delivered_amount for visibility.
  res.json({ ok: true, status: newStatus, attempts, delivered_amount: txn.delivered_amount });
});

router.post("/:id/requeue", (req, res) => {
  db.prepare(`UPDATE transactions SET status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
