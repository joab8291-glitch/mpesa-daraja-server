const rateLimit = require("express-rate-limit");
const { getClientIp } = require("./ipWhitelist");

const callbackLimiter = rateLimit({
  windowMs: 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => getClientIp(req),
  handler: (req, res) => {
    const ip = getClientIp(req);
    console.warn(`[RATE LIMIT] IP ${ip} exceeded 50 req/sec on ${req.path}`);
    res.status(429).json({ error: "Too many requests" });
  },
});

module.exports = { callbackLimiter };
