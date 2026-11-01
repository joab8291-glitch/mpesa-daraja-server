require("dotenv").config();
const express = require("express");
const cors = require("cors");

const stkPushRoutes = require("./routes/stkPush");
const forexDepositRoutes = require("./routes/forexDeposits");
const callbackRoutes = require("./routes/callbacks");
const transactionRoutes = require("./routes/transactions");
const { safaricomOnly } = require("./middleware/ipWhitelist");
const { callbackLimiter } = require("./middleware/rateLimiter");
const { logCallbackAccess } = require("./middleware/logger");
const agentsRoutes = require("./backend-addon/agentsRoutes");
const adminRoutes = require("./backend-addon/adminRoutes");

const app = express();
app.set("trust proxy", true);

const forexOrigins = (process.env.FOREX_ALLOWED_ORIGINS || "")
  .split(",").map((value) => value.trim()).filter(Boolean);
const allowedOrigins = [
  "https://webaziairtimehub.vercel.app",
  "https://webaziairtime.vercel.app",
  "https://airtime.webazi.co.ke",
  "http://localhost:3000",
  ...forexOrigins,
];

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("Not allowed by CORS"));
  },
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/agents", agentsRoutes);
app.use("/admin", adminRoutes);

app.get("/", (req, res) => {
  res.status(200).json({ status: "ok", service: "Webazi Daraja Server", env: process.env.MPESA_ENV || "not set" });
});
app.get("/health", (req, res) => {
  res.status(200).json({ status: "healthy", timestamp: new Date().toISOString() });
});

app.use("/mpesa", stkPushRoutes);
app.use("/forex", forexDepositRoutes);
app.use("/callback", logCallbackAccess, callbackLimiter, safaricomOnly, callbackRoutes);
app.use("/transactions", transactionRoutes);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Webazi Daraja server running on port ${PORT}`);
  console.log(`Environment: ${process.env.MPESA_ENV || "not set"}`);
  console.log(`Forex origins configured: ${forexOrigins.length}`);
});
