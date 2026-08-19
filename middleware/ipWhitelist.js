// Safaricom's published Daraja callback IP range.
// Render/most hosts sit behind a proxy, so the real caller IP is in x-forwarded-for,
// not req.ip directly — we check both to be safe.

function ipToLong(ip) {
  return ip.split(".").reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
}

const ALLOWED_RANGE_START = ipToLong("196.201.214.200");
const ALLOWED_RANGE_END = ipToLong("196.201.214.206");

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress || req.ip;
}

function isIpAllowed(ip) {
  const cleanIp = ip.replace("::ffff:", "");
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(cleanIp)) return false;

  const long = ipToLong(cleanIp);
  return long >= ALLOWED_RANGE_START && long <= ALLOWED_RANGE_END;
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
