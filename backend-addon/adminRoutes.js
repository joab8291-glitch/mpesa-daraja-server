/**
 * Mount in your existing Express app:
 *   const adminRoutes = require('./backend-addon/adminRoutes');
 *   app.use('/admin', adminRoutes);
 *
 * Every route here requires header  x-admin-key: <ADMIN_API_KEY>
 * Set ADMIN_API_KEY in Render's environment variables (same place
 * you set your existing Daraja API_KEY). This key is what your Admin
 * app is built with — never ship it in the Agent or Free-access apps.
 *
 * NOTE: db.js is now Postgres-backed (async), so every handler below
 * awaits its db call — this is the only change from the SQLite version.
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

router.get('/agents', async (req, res) => {
  try {
    res.json({ ok: true, agents: await db.listAgents() });
  } catch (e) {
    console.error('listAgents error:', e);
    res.status(500).json({ ok: false, reason: 'Server error' });
  }
});

router.post('/agents/:id/revoke', async (req, res) => {
  const revoked = req.body?.revoked !== false; // default true
  try {
    const agent = await db.adminRevoke(req.params.id, revoked);
    res.json({ ok: true, agent });
  } catch (e) {
    console.error('adminRevoke error:', e);
    res.status(500).json({ ok: false, reason: 'Server error' });
  }
});

router.post('/agents/:id/free', async (req, res) => {
  const enabled = req.body?.enabled !== false; // default true
  try {
    const agent = await db.adminSetFree(req.params.id, enabled);
    res.json({ ok: true, agent });
  } catch (e) {
    console.error('adminSetFree error:', e);
    res.status(500).json({ ok: false, reason: 'Server error' });
  }
});

router.post('/agents/:id/extend', async (req, res) => {
  const days = Number(req.body?.days);
  if (!days) return res.status(400).json({ ok: false, reason: 'days is required' });
  try {
    const agent = await db.adminExtend(req.params.id, days);
    res.json({ ok: true, agent });
  } catch (e) {
    console.error('adminExtend error:', e);
    res.status(500).json({ ok: false, reason: 'Server error' });
  }
});

router.delete('/agents/:id', async (req, res) => {
  try {
    await db.adminDelete(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    console.error('adminDelete error:', e);
    res.status(500).json({ ok: false, reason: 'Server error' });
  }
});

module.exports = router;
