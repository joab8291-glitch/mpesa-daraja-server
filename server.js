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

app.set("trust proxy", true);

// ---------- CORS ----------
// Only these origins may call the API from a browser. Anything else
// (curl, Postman, the Sambaza worker, server-to-server calls) is unaffected
// by CORS — this only restricts browser-based requests.
const allowedOrigins = [
  "https://webaziairtimehub.vercel.app",
  "https://webaziairtime.vercel.app",
  "http://localhost:3000",
];

app.use(
  cors({
    origin: function (origin, callback) {
      // Allow requests with no origin (curl, Postman, server-to-server, the worker)
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
  })
);

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

app.use("/callback", logCallbackAccess, callbackLimiter, safaricomOnly, callbackRoutes);

app.use("/transactions", transactionRoutes);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Webazi Daraja server running on port ${PORT}`);
  console.log(`Environment: ${process.env.MPESA_ENV || "not set"}`);
});
