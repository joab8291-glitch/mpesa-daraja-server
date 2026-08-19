const express = require("express");
const axios = require("axios");
const { getAccessToken, generateStkPassword } = require("../utils/daraja");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const router = express.Router();

// ---------- CORS ----------
const allowedOrigins = [
  "https://webaziairtimehub.vercel.app",
  "http://localhost:3000", // for local testing
];
router.use(
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

// ---------- Rate Limiting ----------
const stkLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5, // limit each IP to 5 requests per minute
  message: "Too many STK push requests, please try again later.",
});
router.use("/stk-push", stkLimiter); // apply only to STK endpoint

// ---------- In-memory order store (use a DB in production) ----------
const orders = {}; // key: MerchantRequestID, value: order object

// ---------- Helpers ----------
function formatPhone(phone) {
  if (!phone) return null;
  let cleaned = String(phone).replace(/[\s\-+]/g, "");
  if (cleaned.startsWith("0")) {
    cleaned = "254" + cleaned.slice(1);
  }
  if (/^[17]\d{8}$/.test(cleaned)) {
    cleaned = "254" + cleaned;
  }
  if (!/^254[17]\d{8}$/.test(cleaned)) {
    return null;
  }
  return cleaned;
}

// ---------- Routes ----------

// STK Push – initiates M‑PESA prompt
router.post("/stk-push", async (req, res) => {
  try {
    const { phone, amount, accountRef, description } = req.body;

    if (!phone || !amount) {
      return res.status(400).json({ error: "phone and amount are required" });
    }

    const formattedPhone = formatPhone(phone);
    if (!formattedPhone) {
      return res.status(400).json({
        error: "Invalid phone number. Use format 07XXXXXXXX, 2547XXXXXXXX or +2547XXXXXXXX",
      });
    }

    const parsedAmount = parseInt(amount, 10);
    if (isNaN(parsedAmount) || parsedAmount < 1) {
      return res.status(400).json({ error: "amount must be a positive number" });
    }

    const token = await getAccessToken();
    const { password, timestamp } = generateStkPassword();

    const { MPESA_BASE_URL, MPESA_SHORTCODE, MPESA_CALLBACK_URL } = process.env;

    const payload = {
      BusinessShortCode: MPESA_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerPayBillOnline",
      Amount: parsedAmount,
      PartyA: formattedPhone,
      PartyB: MPESA_SHORTCODE,
      PhoneNumber: formattedPhone,
      CallBackURL: MPESA_CALLBACK_URL,
      AccountReference: accountRef || "Webazi",
      TransactionDesc: description || "Payment",
    };

    const response = await axios.post(
      `${MPESA_BASE_URL}/mpesa/stkpush/v1/processrequest`,
      payload,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    // Store order with initial status (pending)
    const respData = response.data;
    if (respData.MerchantRequestID) {
      orders[respData.MerchantRequestID] = {
        merchantRequestId: respData.MerchantRequestID,
        checkoutRequestId: respData.CheckoutRequestID,
        phone: formattedPhone,
        amount: parsedAmount,
        status: "pending", // will be updated by callback
        timestamp: new Date().toISOString(),
      };
    }

    return res.status(200).json(response.data);
  } catch (err) {
    console.error("STK Push error:", err.response?.data || err.message);
    return res.status(500).json({
      error: "Failed to initiate STK Push",
      details: err.response?.data || err.message,
    });
  }
});

// STK Push Query – check status of a previous STK request (for internal use)
router.post("/stk-query", async (req, res) => {
  try {
    const { checkoutRequestId } = req.body;
    if (!checkoutRequestId) {
      return res.status(400).json({ error: "checkoutRequestId is required" });
    }

    const token = await getAccessToken();
    const { password, timestamp } = generateStkPassword();
    const { MPESA_BASE_URL, MPESA_SHORTCODE } = process.env;

    const payload = {
      BusinessShortCode: MPESA_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      CheckoutRequestID: checkoutRequestId,
    };

    const response = await axios.post(
      `${MPESA_BASE_URL}/mpesa/stkpushquery/v1/query`,
      payload,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    return res.status(200).json(response.data);
  } catch (err) {
    console.error("STK Query error:", err.response?.data || err.message);
    return res.status(500).json({
      error: "Failed to query STK status",
      details: err.response?.data || err.message,
    });
  }
});

// NEW: Get order status by merchantRequestId or phone
router.get("/order-status", (req, res) => {
  const { merchantRequestId, phone } = req.query;

  if (!merchantRequestId && !phone) {
    return res.status(400).json({ error: "Provide merchantRequestId or phone" });
  }

  let order = null;
  if (merchantRequestId) {
    order = orders[merchantRequestId] || null;
  } else if (phone) {
    // Find the most recent order for that phone
    const phoneOrders = Object.values(orders).filter(o => o.phone === phone);
    if (phoneOrders.length) {
      // sort by timestamp descending
      phoneOrders.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      order = phoneOrders[0];
    }
  }

  if (!order) {
    return res.status(404).json({ error: "Order not found" });
  }

  res.json(order);
});

// (Optional) Endpoint for Daraja callback to update order status
// You already have a callback route elsewhere – you can update the orders object there
// Example: when callback receives successful payment, update orders[merchantRequestId].status = 'completed'

module.exports = router;
