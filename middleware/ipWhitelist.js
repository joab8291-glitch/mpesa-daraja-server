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
]);

// Render sits in front of this app as a reverse proxy. Render appends the
// real connecting client's IP as the LAST entry in X-Forwarded-For — any
// earlier entries may have been set by the client itself and can't be
// trusted. Taking the first entry (the old behavior) let a client spoof
// this check by pre-setting the header themselves.
function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    const ips = forwarded.split(",").map((ip) => ip.trim());
    return ips[ips.length - 1];
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
