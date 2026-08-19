const express = require("express");
const { db } = require("../db");
const router = express.Router();

router.get("/pending", (req, res) => {
  const rows = db.prepare(`SELECT * FROM transactions WHERE status = 'pending' ORDER BY created_at ASC`).all();
  res.json(rows);
});

router.get("/", (req, res) => {
  const status = req.query.status;
  const rows = status
    ? db.prepare(`SELECT * FROM transactions WHERE status = ? ORDER BY created_at DESC`).all(status)
    : db.prepare(`SELECT * FROM transactions ORDER BY created_at DESC`).all();
  res.json(rows);
});

router.post("/:id/complete", (req, res) => {
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

  res.json({ ok: true, status: newStatus, attempts });
});

router.post("/:id/requeue", (req, res) => {
  db.prepare(`UPDATE transactions SET status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
