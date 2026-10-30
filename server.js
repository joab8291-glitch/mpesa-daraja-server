require("dotenv").config();
const express = require("express");
const cors = require("cors");

const stkPushRoutes = require("./routes/stkPush");
const callbackRoutes = require("./routes/callbacks");
const transactionRoutes = require("./routes/transactions");
const { safaricomOnly } = require("./middleware/ipWhitelist");
const { callbackLimiter } = require("./middleware/rateLimiter");
const { logCallbackAccess } = require("./middleware/logger");
const agentsRoutes = require("./backend-addon/agentsRoutes");
const adminRoutes = require("./backend-addon/adminRoutes");

const app = express();

// Render is behind a proxy. Keep this setting aligned with the actual trusted
// proxy topology; never use X-Forwarded-For alone as callback authentication.
app.set("trust proxy", 1);
app.disable("x-powered-by");

// ---------- CORS ----------
const allowedOrigins = [
  "https://webaziairtimehub.vercel.app",
  "https://webaziairtime.vercel.app",
  "http://localhost:3000",
];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
  })
);

// Limit request bodies to reduce memory/DoS risk from oversized JSON/form posts.
app.use(express.json({ limit: "64kb", strict: true }));
app.use(express.urlencoded({ extended: false, limit: "16kb", parameterLimit: 100 }));

app.use("/agents", agentsRoutes);
app.use("/admin", adminRoutes);

app.get("/", (req, res) => {
  res.status(200).json({ status: "ok", service: "Webazi Daraja Server", env: process.env.MPESA_ENV || "not set" });
});

app.get("/health", (req, res) => {
  res.status(200).json({ status: "healthy", timestamp: new Date().toISOString() });
});

app.use("/mpesa", stkPushRoutes);

// Callbacks are restricted to Safaricom's published IPs (see middleware/ipWhitelist.js).
app.use("/callback", logCallbackAccess, callbackLimiter, safaricomOnly, callbackRoutes);

app.use("/transactions", transactionRoutes);

// Generic error handler: do not expose internal exception details to callers.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err && err.type === "entity.too.large") {
    return res.status(413).json({ error: "Request body too large" });
  }
  if (err && err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Invalid request body" });
  }
  if (err && err.message === "Not allowed by CORS") {
    return res.status(403).json({ error: "Origin not allowed" });
  }
  console.error("[HTTP] Unhandled request error:", err?.message || "unknown error");
  return res.status(500).json({ error: "Internal server error" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Webazi Daraja server running on port ${PORT}`);
  console.log(`Environment: ${process.env.MPESA_ENV || "not set"}`);
});
