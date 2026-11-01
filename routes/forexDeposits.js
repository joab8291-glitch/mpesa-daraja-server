const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");

const { getAccessToken, generateStkPassword } = require("../utils/daraja");
const { createDeposit, attachMpesaRequest, failDeposit, getWallet, getDepositForUser } = require("../utils/forexDb");
const { auth: authenticateForexUser } = require("./forexAuth");

const router = express.Router();
const limiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 8, standardHeaders: true, legacyHeaders: false });
const statusLimiter = rateLimit({ windowMs: 5 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });

function allowedOrigin(req, res, next) {
  const origin = req.get("origin");
  const allowed = (process.env.FOREX_ALLOWED_ORIGINS || "").split(",").map((v) => v.trim()).filter(Boolean);
  if (!origin || !allowed.includes(origin)) {
    return res.status(403).json({ error: "Forex origin is not allowed. Configure FOREX_ALLOWED_ORIGINS." });
  }
  next();
}


function formatPhone(phone) {
  const cleaned = String(phone || "").replace(/[\s\-+]/g, "");
  const normalized = cleaned.startsWith("0") ? "254" + cleaned.slice(1)
    : /^[17]\d{8}$/.test(cleaned) ? "254" + cleaned : cleaned;
  return /^254[17]\d{8}$/.test(normalized) ? normalized : null;
}

router.use(allowedOrigin, authenticateForexUser);

router.get("/wallet", statusLimiter, async (req, res) => {
  try {
    return res.json({ currency: "KES", balanceKes: await getWallet(req.forexUser.id) });
  } catch (error) {
    console.error("Forex wallet read failed:", error.message);
    return res.status(500).json({ error: "Could not load your Forex wallet." });
  }
});

router.post("/deposits/stk-push", limiter, async (req, res) => {
  const phone = formatPhone(req.body?.phone);
  const amount = Number(req.body?.amount);
  if (!phone) return res.status(400).json({ error: "Enter a valid Kenyan M-Pesa number." });
  if (!Number.isSafeInteger(amount) || amount < 100 || amount > 100000) {
    return res.status(400).json({ error: "Deposit must be between KES 100 and KES 100,000 in whole shillings." });
  }

  const id = crypto.randomUUID();
  try {
    await createDeposit({ id, userId: req.forexUser.id, amount, phone });
    const token = await getAccessToken();
    const { password, timestamp } = generateStkPassword();
    const { MPESA_BASE_URL, MPESA_SHORTCODE, MPESA_CALLBACK_URL } = process.env;
    if (!MPESA_BASE_URL || !MPESA_SHORTCODE || !MPESA_CALLBACK_URL) throw new Error("M-Pesa Daraja environment is incomplete");

    const response = await axios.post(
      `${MPESA_BASE_URL}/mpesa/stkpush/v1/processrequest`,
      {
        BusinessShortCode: MPESA_SHORTCODE, Password: password, Timestamp: timestamp,
        TransactionType: "CustomerPayBillOnline", Amount: amount, PartyA: phone,
        PartyB: MPESA_SHORTCODE, PhoneNumber: phone, CallBackURL: MPESA_CALLBACK_URL,
        AccountReference: `FX-${id.slice(0, 10)}`, TransactionDesc: "Forex wallet deposit",
      },
      { headers: { Authorization: `Bearer ${token}` }, timeout: 30000 }
    );
    const data = response.data || {};
    if (String(data.ResponseCode) !== "0" || !data.MerchantRequestID || !data.CheckoutRequestID) {
      throw new Error(data.ResponseDescription || data.errorMessage || "Safaricom did not accept the STK request");
    }
    await attachMpesaRequest({ id, merchantRequestId: data.MerchantRequestID, checkoutRequestId: data.CheckoutRequestID });
    return res.status(202).json({
      ok: true, status: "pending", merchantRequestId: data.MerchantRequestID,
      checkoutRequestId: data.CheckoutRequestID, customerMessage: data.CustomerMessage || "Check your phone and enter your M-Pesa PIN.",
      amountKes: amount,
    });
  } catch (error) {
    await failDeposit(id, error.response?.data?.errorMessage || error.message).catch((dbError) =>
      console.error("Could not mark Forex deposit failed:", dbError.message));
    console.error("Forex STK Push failed:", error.response?.data || error.message);
    return res.status(502).json({ error: error.response?.data?.errorMessage || "Could not start the M-Pesa payment. Please try again." });
  }
});

router.get("/deposits/:merchantRequestId", statusLimiter, async (req, res) => {
  try {
    const deposit = await getDepositForUser(req.params.merchantRequestId, req.forexUser.id);
    if (!deposit) return res.status(404).json({ error: "Deposit not found." });
    return res.json({
      merchantRequestId: deposit.merchant_request_id, amountKes: Number(deposit.amount_kes),
      phone: deposit.phone, status: deposit.status, receipt: deposit.mpesa_receipt,
      error: deposit.failure_reason, createdAt: deposit.created_at, updatedAt: deposit.updated_at,
    });
  } catch (error) {
    console.error("Forex deposit status failed:", error.message);
    return res.status(500).json({ error: "Could not check this deposit." });
  }
});

module.exports = router;
