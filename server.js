require("dotenv").config();
const express = require("express");
const cors = require("cors");

const stkPushRoutes = require("./routes/stkPush");
const callbackRoutes = require("./routes/callbacks");
const transactionRoutes = require("./routes/transactions");
const { safaricomOnly } = require("./middleware/ipWhitelist");
const { callbackLimiter } = require("./middleware/rateLimiter");
const { logCallbackAccess } = require("./middleware/logger");

const app = express();

app.set("trust proxy", true);

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
