/**
 * Mount in your existing Express app:
 *   const agentsRoutes = require('./backend-addon/agentsRoutes');
 *   app.use('/agents', agentsRoutes);
 *
 * Called by the Agent app and the Free-access app (services/agentBackend.ts).
 * Never trust build_variant alone for granting free access on sensitive
 * flows — it's set at registration for visibility in the admin dashboard,
 * but actual gating always reads back is_free_access/status from here.
 *
 * NOTE: db.js is now Postgres-backed (async), so every handler below
 * awaits its db call — this is the only change from the SQLite version.
 */
const express = require('express');
const db = require('./db');

const router = express.Router();
router.use(express.json());

router.post('/register', async (req, res) => {
  const { notificationNumber, passwordHashClient, deviceId, buildVariant } = req.body || {};
  if (!notificationNumber || !passwordHashClient) {
    return res.status(400).json({ ok: false, reason: 'notificationNumber and passwordHashClient are required' });
  }
  try {
    const { agent, agentId, agentKey } = await db.registerAgent({
      notificationNumber,
      passwordHashClient,
      deviceId,
      buildVariant,
    });
    res.json({ ok: true, agentId, agentKey, agent });
  } catch (e) {
    if (e.code === 'ALREADY_EXISTS') {
      return res.status(409).json({ ok: false, reason: e.message });
    }
    console.error('register error:', e);
    res.status(500).json({ ok: false, reason: 'Server error' });
  }
});

router.post('/login', async (req, res) => {
  const { notificationNumber, passwordHashClient, deviceId } = req.body || {};
  if (!notificationNumber || !passwordHashClient) {
    return res.status(400).json({ ok: false, reason: 'notificationNumber and passwordHashClient are required' });
  }
  try {
    const { agent, agentId, agentKey } = await db.loginAgent({ notificationNumber, passwordHashClient, deviceId });
    res.json({ ok: true, agentId, agentKey, agent });
  } catch (e) {
    if (e.code === 'NOT_FOUND' || e.code === 'BAD_PASSWORD') {
      return res.status(401).json({ ok: false, reason: e.message });
    }
    console.error('login error:', e);
    res.status(500).json({ ok: false, reason: 'Server error' });
  }
});

router.get('/:id/status', async (req, res) => {
  const agentKey = req.header('x-agent-key');
  if (!agentKey) return res.status(401).json({ ok: false, reason: 'Missing x-agent-key' });
  try {
    const agent = await db.getStatus(req.params.id, agentKey);
    res.json({ ok: true, agent });
  } catch (e) {
    res.status(404).json({ ok: false, reason: 'Not found' });
  }
});

router.post('/:id/payment', async (req, res) => {
  const agentKey = req.header('x-agent-key');
  if (!agentKey) return res.status(401).json({ ok: false, reason: 'Missing x-agent-key' });
  const { months, method, reference } = req.body || {};
  if (![1, 2].includes(Number(months)) || !['stk', 'sambaza'].includes(method)) {
    return res.status(400).json({ ok: false, reason: 'Invalid months/method' });
  }
  try {
    const agent = await db.recordPayment(req.params.id, agentKey, { months, method, reference });
    res.json({ ok: true, agent });
  } catch (e) {
    res.status(404).json({ ok: false, reason: 'Not found' });
  }
});

module.exports = router;
