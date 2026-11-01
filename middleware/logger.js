const { getClientIp } = require("./ipWhitelist");

// Render's disk is ephemeral (wiped on every deploy/restart), so writing
// callback logs to a file on it never actually persists anything — it
// only produced the "Failed to write log: ENOENT" errors on every
// request. Render already captures console output in its own log
// viewer, so that's the log that's actually durable; this middleware
// now just writes to it directly.
function logCallbackAccess(req, res, next) {
  const ip = getClientIp(req);
  const timestamp = new Date().toISOString();
  console.log(`[ACCESS] ${timestamp} ${ip} ${req.method} ${req.path} | body: ${JSON.stringify(req.body)}`);
  next();
}

module.exports = { logCallbackAccess };
