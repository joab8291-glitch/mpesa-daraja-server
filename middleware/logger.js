const fs = require("fs");
const path = require("path");
const { getClientIp } = require("./ipWhitelist");

const logFile = path.join(__dirname, "..", "logs", "callback-access.log");

function logCallbackAccess(req, res, next) {
  const ip = getClientIp(req);
  const timestamp = new Date().toISOString();
  const line = `${timestamp} | ${ip} | ${req.method} ${req.path} | body: ${JSON.stringify(req.body)}\n`;

  fs.appendFile(logFile, line, (err) => {
    if (err) console.error("Failed to write log:", err.message);
  });

  console.log(`[ACCESS] ${timestamp} ${ip} ${req.method} ${req.path}`);
  next();
}

module.exports = { logCallbackAccess };
