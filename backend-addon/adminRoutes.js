/**
 * Mount in your existing Express app:
 *   const adminRoutes = require('./backend-addon/adminRoutes');
 *   app.use('/admin', adminRoutes);
 *
 * Every route here requires header  x-admin-key: <ADMIN_API_KEY>
 * Set ADMIN_API_KEY in Render's environment variables (same place
 * you set your existing Daraja API_KEY). This key is what your Admin
 * app is built with — never ship it in the Agent or Free-access apps.
 */
const express = require('express');
const db = require('./db');

const router = express.Router();
router.use(express.json());

router.use((req, res, next) => {
  const key = req.header('x-admin-key');
  if (!key || key !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ ok: false, reason: 'Invalid or missing admin key' });
  }
  next();
});

router.get('/agents', (req, res) => {
  res.json({ ok: true, agents: db.listAgents() });
});

router.post('/agents/:id/revoke', (req, res) => {
  const revoked = req.body?.revoked !== false; // default true
  const agent = db.adminRevoke(req.params.id, revoked);
  res.json({ ok: true, agent });
});

router.post('/agents/:id/free', (req, res) => {
  const enabled = req.body?.enabled !== false; // default true
  const agent = db.adminSetFree(req.params.id, enabled);
  res.json({ ok: true, agent });
});

router.post('/agents/:id/extend', (req, res) => {
  const days = Number(req.body?.days);
  if (!days) return res.status(400).json({ ok: false, reason: 'days is required' });
  const agent = db.adminExtend(req.params.id, days);
  res.json({ ok: true, agent });
});

router.delete('/agents/:id', (req, res) => {
  db.adminDelete(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
