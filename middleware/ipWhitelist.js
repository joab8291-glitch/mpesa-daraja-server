// Safaricom's published Daraja callback IPs (from the Daraja developer portal).
// This is a discrete list, not a contiguous range — Safaricom's callback
// senders span more than one subnet, so a min/max range check misses valid IPs.
const ALLOWED_IPS = new Set([
  "196.201.214.200",
  "196.201.214.206",
  "196.201.213.114",
  "196.201.214.207",
  "196.201.214.208",
  "196.201.213.44",
  "196.201.212.127",
  "196.201.212.138",
  "196.201.212.129",
  "196.201.212.136",
  "196.201.212.74",
  "196.201.212.69",
  "154.159.113.171",
]);

// Confirmed from production X-Forwarded-For captures on 2026-09-08:
//   196.201.213.44, 172.71.146.175, 10.24.213.77
//   196.201.212.127, 172.71.151.192, 10.30.181.89
// The FIRST entry (196.201.213.44 / 196.201.212.127) matches Safaricom's
// published Daraja IPs below. The last two entries are added AFTER
// Safaricom's request — a proxy layer in front of Render, then Render's
// own internal private network. Taking the LAST entry (the previous
// behavior) grabbed Render's internal address instead of Safaricom's,
// which blocked every single legitimate callback.
//
// Caveat: taking the first entry trusts whatever a client sends as its
// own X-Forwarded-For value. If this app's raw onrender.com URL (rather
// than only a domain sitting behind the proxy layer above) is reachable
// directly, someone could set X-Forwarded-For themselves to spoof a
// whitelisted IP at position 0. If that's a concern, consider adding a
// second check independent of IP (e.g. a shared secret in the callback
// URL query string that only your registered Daraja config knows).
function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    const ips = forwarded.split(",").map((ip) => ip.trim());
    return ips[0];
  }
  return req.socket.remoteAddress || req.ip;
}

function isIpAllowed(ip) {
  const cleanIp = ip.replace("::ffff:", "");
  return ALLOWED_IPS.has(cleanIp);
}

function safaricomOnly(req, res, next) {
  const clientIp = getClientIp(req);

  if (isIpAllowed(clientIp)) {
    return next();
  }

  console.warn(`[BLOCKED] Non-Safaricom IP attempted callback: ${clientIp} on ${req.path}`);
  return res.status(403).json({ error: "Forbidden" });
}

module.exports = { safaricomOnly, getClientIp };
