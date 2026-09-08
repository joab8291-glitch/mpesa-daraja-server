const express = require("express");
const {
  listByStatuses,
  listAll,
  getByReceipt,
  getById,
  updateDeliveredAmount,
  markCompleted,
  markFailOrRetry,
  markRequeue,
} = require("../db");
const router = express.Router();

/**
 * Simple API key protection — same pattern as routes/stkPush.js
 * Expects header: x-api-key: YOUR_SECRET
 */
function checkApiKey(req, res, next) {
  const apiKey = process.env.API_KEY;

  // Fail closed: if API_KEY isn't configured, refuse every request rather
  // than silently letting them all through.
  if (!apiKey) {
    console.error("API_KEY is not set — refusing request. Set API_KEY in your environment.");
    return res.status(500).json({ error: "Server misconfiguration: API key not set" });
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
router.get("/pending", async (req, res) => {
  const rows = await listByStatuses(["pending", "retry"]);
  res.json(rows);
});

router.get("/", async (req, res) => {
  const status = req.query.status;
  const rows = await listAll(status);
  res.json(rows);
});

// NEW: lets the Sambaza worker find a transaction's id from the M-Pesa
// receipt number it reads out of the SMS notification, so it can still
// call /progress, /complete, /fail below without polling /pending first.
router.get("/by-receipt/:receipt", async (req, res) => {
  const txn = await getByReceipt(req.params.receipt);

  if (!txn) {
    return res.status(404).json({ error: "No transaction found for that receipt" });
  }

  res.json(txn);
});

// NEW: called after EVERY successful Sambaza chunk — records cumulative progress
// so a retry never re-dials airtime that was already delivered.
router.post("/:id/progress", async (req, res) => {
  const { deliveredAmount } = req.body || {};

  if (typeof deliveredAmount !== "number" || deliveredAmount < 0) {
    return res.status(400).json({ error: "deliveredAmount must be a non-negative number" });
  }

  const txn = await getById(req.params.id);
  if (!txn) return res.status(404).json({ error: "Transaction not found" });

  const newDelivered = Math.max(txn.delivered_amount, deliveredAmount);

  await updateDeliveredAmount(req.params.id, newDelivered);

  console.log(`Txn #${req.params.id}: progress ${newDelivered}/${txn.amount}`);
  res.json({ ok: true, delivered_amount: newDelivered });
});

router.post("/:id/complete", async (req, res) => {
  // CHANGED: added the safety check below — was previously a straight UPDATE with no guard.
  const txn = await getById(req.params.id);
  if (!txn) return res.status(404).json({ error: "Transaction not found" });

  if (txn.delivered_amount < txn.amount) {
    return res.status(400).json({
      error: "Cannot complete — delivered_amount is less than amount",
      delivered_amount: txn.delivered_amount,
      amount: txn.amount,
    });
  }

  await markCompleted(req.params.id);
  res.json({ ok: true });
});

router.post("/:id/fail", async (req, res) => {
  const { reason } = req.body || {};
  const txn = await getById(req.params.id);
  if (!txn) return res.status(404).json({ error: "Transaction not found" });

  const attempts = txn.attempts + 1;
  const newStatus = attempts >= 3 ? "failed" : "retry";

  await markFailOrRetry(req.params.id, newStatus, attempts, reason || null);

  // CHANGED: response now also includes delivered_amount for visibility.
  res.json({ ok: true, status: newStatus, attempts, delivered_amount: txn.delivered_amount });
});

router.post("/:id/requeue", async (req, res) => {
  await markRequeue(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
