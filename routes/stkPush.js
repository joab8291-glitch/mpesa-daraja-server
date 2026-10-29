const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const {
  createStkAttempt,
  getStkAttemptByRequestId,
  updateStkAttempt,
  getByMerchantRequestId,
  getLatestByPhone,
} = require("../db");
const { getAccessToken, generateStkPassword } = require("../utils/daraja");
const { globalOrders } = require("../utils/orders");

const router = express.Router();

const publicStkLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many payment attempts. Please wait a few minutes before trying again." },
});

// ---------- Helpers ----------

/**
 * Normalize Kenyan phone numbers to 2547XXXXXXXX format
 * Accepts: 07..., 7..., +2547..., 2547...
 */
function formatPhone(phone) {
  if (!phone) return null;

  // Remove spaces, dashes, plus signs
  let cleaned = String(phone).replace(/[\s\-+]/g, "");

  // Convert 07... or 01... to 2547... / 2541...
  if (cleaned.startsWith("0")) {
    cleaned = "254" + cleaned.slice(1);
  }

  // Convert 7... or 1... (9 digits) to 2547...
  if (/^[17]\d{8}$/.test(cleaned)) {
    cleaned = "254" + cleaned;
  }

  // Final validation: must be 254 followed by 9 digits
  if (!/^254[17]\d{8}$/.test(cleaned)) {
    return null;
  }

  return cleaned;
}

/**
 * Simple API key protection
 * Expects header: x-api-key: YOUR_SECRET
 */
function checkApiKey(req, res, next) {
  // The static customer site cannot keep a secret API key. The public STK
  // endpoint is instead protected by strict validation, origin checks and
  // per-IP rate limiting. Administrative/status routes still require API_KEY.
  if (req.path === "/stk-push" || req.path === "/stk-query") {
    const origin = req.get("origin");
    const allowedOrigins = new Set([
      "https://webaziairtime.vercel.app",
      "https://webaziairtimehub.vercel.app",
      "http://localhost:3000",
    ]);
    if (origin && !allowedOrigins.has(origin)) {
      return res.status(403).json({ error: "Origin not allowed" });
    }
    return next();
  }

  const apiKey = process.env.API_KEY;

  // Fail closed: if API_KEY isn't configured, refuse every request rather
  // than silently letting them all through.
  if (!apiKey) {
    console.error("API_KEY is not set — refusing request. Set API_KEY in your environment.");
    return res.status(500).json({ error: "Server misconfiguration: API key not set" });
  }

  const provided = req.headers["x-api-key"];

  if (!provided || provided !== apiKey) {
    return res.status(401).json({ error: "Unauthorized – invalid or missing API key" });
  }

  next();
}

// Apply API key check to all routes in this file
router.use(checkApiKey);

// ---------- Routes ----------

router.post("/stk-push", publicStkLimiter, async (req, res) => {
  let stage = "request_validation";
  let attemptRequestId = null;
  const startedAt = Date.now();
  let oauthMs = null;
  let upstreamMs = null;
  try {
    const { phone, amount, accountRef, description, clientRequestId } = req.body;

    if (!phone || !amount) {
      return res.status(400).json({ error: "phone and amount are required" });
    }

    const formattedPhone = formatPhone(phone);

    if (!formattedPhone) {
      return res.status(400).json({
        error: "Invalid phone number. Use format 07XXXXXXXX, 2547XXXXXXXX or +2547XXXXXXXX",
      });
    }

    // Accept only integer KES values; parseInt("100abc") must not pass.
    const parsedAmount = Number(amount);
    if (!Number.isSafeInteger(parsedAmount) || parsedAmount < 1 || parsedAmount > 10000) {
      return res.status(400).json({ error: "amount must be a whole number between KES 1 and KES 10,000" });
    }

    const requestId = typeof clientRequestId === "string" &&
      /^[a-zA-Z0-9_-]{8,100}$/.test(clientRequestId)
      ? clientRequestId
      : crypto.randomUUID();
    attemptRequestId = requestId;

    const { row: attempt, created } = await createStkAttempt({
      requestId,
      phone: formattedPhone,
      amount: parsedAmount,
      accountRef: accountRef || "Webazi",
    });

    // Idempotency: the same browser submission must never start a second STK
    // push, including after a client/network timeout.
    if (!created) {
      if (!attempt) return res.status(500).json({ error: "Could not load payment attempt" });
      const knownResponse = {
        status: attempt.status,
        clientRequestId: attempt.request_id,
        MerchantRequestID: attempt.merchant_request_id || undefined,
        CheckoutRequestID: attempt.checkout_request_id || undefined,
        message: attempt.status === "outcome_unknown"
          ? "Payment request outcome is not yet known. Do not submit another payment; check your M-PESA messages or track this order."
          : "This request was already submitted. Check its status instead of creating another payment.",
      };
      const existingStatus = ["accepted", "payment_confirmed"].includes(attempt.status) ? 200
        : attempt.status === "failed" || attempt.status === "rejected" ? 409 : 202;
      return res.status(existingStatus).json(knownResponse);
    }

    const {
      MPESA_BASE_URL,
      MPESA_SHORTCODE,
      MPESA_CALLBACK_URL,
      MPESA_PASSKEY,
      MPESA_CONSUMER_KEY,
      MPESA_CONSUMER_SECRET,
    } = process.env;

    const missing = [
      ["MPESA_BASE_URL", MPESA_BASE_URL],
      ["MPESA_SHORTCODE", MPESA_SHORTCODE],
      ["MPESA_CALLBACK_URL", MPESA_CALLBACK_URL],
      ["MPESA_PASSKEY", MPESA_PASSKEY],
      ["MPESA_CONSUMER_KEY", MPESA_CONSUMER_KEY],
      ["MPESA_CONSUMER_SECRET", MPESA_CONSUMER_SECRET],
    ].filter(([, value]) => !value).map(([name]) => name);

    if (missing.length) {
      await updateStkAttempt(requestId, {
        status: "failed",
        failure_reason: "M-PESA configuration is incomplete",
      });
      console.error("[MPESA][CONFIG] Missing required environment variables:", missing.join(", "));
      return res.status(500).json({
        error: "M-PESA configuration is incomplete",
        missing,
      });
    }

    let baseUrl;
    try {
      baseUrl = new URL(MPESA_BASE_URL);
      if (!["https:", "http:"].includes(baseUrl.protocol) || baseUrl.pathname !== "/" || baseUrl.search || baseUrl.hash) {
        throw new Error("MPESA_BASE_URL must be the base URL only");
      }
    } catch (configError) {
      await updateStkAttempt(requestId, {
        status: "failed",
        failure_reason: "Invalid M-PESA base URL configuration",
      });
      console.error("[MPESA][CONFIG] MPESA_BASE_URL must be a valid base URL, e.g. https://api.safaricom.co.ke");
      return res.status(500).json({ error: "Invalid M-PESA base URL configuration" });
    }

    stage = "oauth";
    const oauthStartedAt = Date.now();
    const token = await getAccessToken();
    oauthMs = Date.now() - oauthStartedAt;
    const { password, timestamp } = generateStkPassword();

    stage = "stk_push";
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

    const upstreamStartedAt = Date.now();
    const response = await axios.post(
      `${baseUrl.origin}/mpesa/stkpush/v1/processrequest`,
      payload,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 }
    );
    upstreamMs = Date.now() - upstreamStartedAt;

    // Persist Daraja IDs immediately; callbacks can now reconcile after restart.
    const respData = response.data || {};
    const accepted = response.status >= 200 && response.status < 300 &&
      (respData.ResponseCode === "0" || respData.CheckoutRequestID || respData.MerchantRequestID);
    await updateStkAttempt(requestId, {
      status: accepted ? "accepted" : "rejected",
      merchant_request_id: respData.MerchantRequestID || null,
      checkout_request_id: respData.CheckoutRequestID || null,
      response_code: respData.ResponseCode == null ? null : String(respData.ResponseCode),
      failure_reason: accepted ? null : (respData.ResponseDescription || respData.errorMessage || "Daraja did not accept the STK request"),
    });
    if (respData.MerchantRequestID) {
      globalOrders[respData.MerchantRequestID] = {
        merchantRequestId: respData.MerchantRequestID,
        checkoutRequestId: respData.CheckoutRequestID,
        phone: formattedPhone,
        amount: parsedAmount,
        status: "pending",
        timestamp: new Date().toISOString(),
        receipt: null,
        completedAt: null,
      };
      console.log("[MPESA][STK_ORDER_STORED]", {
        requestId,
        hasMerchantRequestId: Boolean(respData.MerchantRequestID),
        hasCheckoutRequestId: Boolean(respData.CheckoutRequestID),
      });
    }

    console.log("[MPESA][STK_TIMING]", {
      requestId,
      stage: "complete",
      oauthMs,
      upstreamMs,
      totalMs: Date.now() - startedAt,
      upstreamStatus: response.status,
    });
    return res.status(200).json({ ...respData, clientRequestId: requestId });
  } catch (err) {
    const status = err.response?.status || null;
    const responseData = err.response?.data;
    const safeResponse = responseData && typeof responseData === "object"
      ? {
          requestId: responseData.requestId,
          errorCode: responseData.errorCode,
          errorMessage: responseData.errorMessage,
          ResponseCode: responseData.ResponseCode,
          ResponseDescription: responseData.ResponseDescription,
          CustomerMessage: responseData.CustomerMessage,
        }
      : undefined;

    const outcomeUnknown = stage === "stk_push" && !status;
    if (attemptRequestId) {
      try {
        await updateStkAttempt(attemptRequestId, {
          status: outcomeUnknown ? "outcome_unknown" : "failed",
          failure_reason: outcomeUnknown
            ? "No definitive response from Daraja; payment outcome requires reconciliation"
            : (safeResponse?.errorMessage || safeResponse?.ResponseDescription || err.message || "STK initiation failed"),
        });
      } catch (persistError) {
        console.error("[MPESA][ATTEMPT_PERSIST_FAILED]", {
          requestId: attemptRequestId,
          message: persistError.message,
        });
      }
    }

    console.error("[MPESA][STK_INITIATION_FAILED]", {
      requestId: attemptRequestId,
      stage,
      httpStatus: status,
      errorCode: err.code || null,
      message: err.message,
      oauthMs,
      upstreamMs: upstreamMs ?? (stage === "stk_push" ? Date.now() - startedAt - (oauthMs || 0) : null),
      totalMs: Date.now() - startedAt,
      outcomeUnknown,
      safaricomResponse: safeResponse || null,
    });

    return res.status(outcomeUnknown ? 202 : 502).json({
      error: outcomeUnknown
        ? "Payment request outcome is unknown"
        : "Failed to initiate STK Push",
      status: outcomeUnknown ? "outcome_unknown" : "failed",
      clientRequestId: attemptRequestId,
      message: outcomeUnknown
        ? "Do not retry this payment yet. Check M-PESA messages or contact support while the request is reconciled."
        : "The payment request was rejected or could not be initiated. You may try again after checking the result.",
      stage,
      upstreamStatus: status,
      upstreamCode: err.code || null,
      details: safeResponse || "Upstream connection failed; check server logs for the stage and error code.",
    });
  }
});

// STK Push Query – check status of a previous STK request
router.post("/stk-query", publicStkLimiter, async (req, res) => {
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

    // Keep the in-memory order in sync with the query result.
    const respData = response.data;
    if (respData.MerchantRequestID && globalOrders[respData.MerchantRequestID]) {
      if (respData.ResultCode === "0") {
        globalOrders[respData.MerchantRequestID].status = "completed";
      } else if (respData.ResultCode) {
        globalOrders[respData.MerchantRequestID].status = "failed";
        globalOrders[respData.MerchantRequestID].error = respData.ResultDesc;
      }
    }

    return res.status(200).json(response.data);
  } catch (err) {
    console.error("STK Query error:", err.response?.data || err.message);
    return res.status(500).json({
      error: "Failed to query STK status",
      details: err.response?.data || err.message,
    });
  }
});

// GET order status by merchantRequestId or phone.
// Protected by the same checkApiKey middleware applied to this whole router.
router.get("/order-status", async (req, res) => {
  const { merchantRequestId, phone } = req.query;

  if (!merchantRequestId && !phone) {
    return res.status(400).json({ error: "Provide merchantRequestId or phone" });
  }

  // Check the durable database FIRST — this survives server restarts,
  // unlike globalOrders which resets to empty on every redeploy/restart.
  let dbRow = null;
  if (merchantRequestId) {
    dbRow = await getByMerchantRequestId(merchantRequestId);
  } else if (phone) {
    const formattedPhone = formatPhone(phone);
    if (!formattedPhone) {
      return res.status(400).json({ error: "Invalid phone number format" });
    }
    dbRow = await getLatestByPhone(formattedPhone);
  }

  if (dbRow) {
    return res.json({
      merchantRequestId: dbRow.merchant_request_id,
      phone: dbRow.phone,
      amount: dbRow.amount,
      status: dbRow.status,
      receipt: dbRow.receipt,
      error: dbRow.failure_reason,
      completedAt: dbRow.updated_at,
    });
  }

  // Fall back to the in-memory cache — this only covers orders where the
  // callback hasn't arrived yet (still genuinely "pending"), which is the
  // one case the database can't yet answer.
  let order = null;
  if (merchantRequestId) {
    order = globalOrders[merchantRequestId] || null;
  } else if (phone) {
    const formattedPhone = formatPhone(phone);
    const phoneOrders = Object.values(globalOrders).filter((o) => o.phone === formattedPhone);
    if (phoneOrders.length) {
      phoneOrders.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      order = phoneOrders[0];
    }
  }

  if (!order) {
    return res.status(404).json({ error: "Order not found" });
  }

  res.json(order);
});

module.exports = router;
