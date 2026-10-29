const crypto = require("crypto");

/**
 * Require a high-entropy shared secret on registered Daraja callback URLs.
 * Configure MPESA_CALLBACK_SECRET in Render (32+ random bytes), then append
 * ?token=<same-secret> to each callback URL registered with Daraja.
 *
 * This is an additional control; do not treat X-Forwarded-For as proof of
 * identity because direct requests can spoof that header.
 */
function callbackSecret(req, res, next) {
  const expected = process.env.MPESA_CALLBACK_SECRET;
  const provided = typeof req.query.token === "string" ? req.query.token : "";

  if (!expected || expected.length < 32) {
    console.error("[SECURITY] MPESA_CALLBACK_SECRET missing/too short; callback rejected");
    return res.status(503).json({ error: "Callback authentication is not configured" });
  }

  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  const matches =
    expectedBuffer.length === providedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, providedBuffer);

  if (!matches) {
    console.warn("[SECURITY] Rejected callback without valid shared secret");
    return res.status(403).json({ error: "Forbidden" });
  }

  return next();
}

module.exports = { callbackSecret };
