const { getClientIp } = require("./ipWhitelist");

// Never log complete callback bodies: they can contain customer phone numbers,
// receipts and payment metadata. Log only minimal operational identifiers.
function logCallbackAccess(req, res, next) {
  const timestamp = new Date().toISOString();
  const ip = getClientIp(req);
  const callbackType = req.path.endsWith("/stk-callback")
    ? "stk"
    : req.path.endsWith("/confirmation")
      ? "c2b-confirmation"
      : req.path.endsWith("/validation")
        ? "c2b-validation"
        : "unknown";

  console.log(`[CALLBACK] ${timestamp} type=${callbackType} ip=${ip}`);
  next();
}

module.exports = { logCallbackAccess };
