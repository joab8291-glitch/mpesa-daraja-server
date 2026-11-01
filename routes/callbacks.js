const express = require("express");
const { receiptExists, insertTransaction } = require("../db");
const { settleForexCallback } = require("../utils/forexDb");
const { globalOrders } = require("../utils/orders");

const router = express.Router();

router.post("/stk-callback", async (req, res) => {
  const body = req.body;
  if (!body || Object.keys(body).length === 0) {
    return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
  }

  const callback = body?.Body?.stkCallback;
  if (!callback) {
    console.warn("Unrecognized callback payload:", JSON.stringify(body));
    return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
  }

  const { ResultCode, ResultDesc, CallbackMetadata, MerchantRequestID, CheckoutRequestID } = callback;
  const items = CallbackMetadata?.Item || [];
  const getVal = (name) => items.find((item) => item.Name === name)?.Value;
  const amount = getVal("Amount");
  const receipt = String(getVal("MpesaReceiptNumber") || "");
  const phone = String(getVal("PhoneNumber") || "");

  console.log("📥 STK callback received", { ResultCode, MerchantRequestID, CheckoutRequestID });

  // Forex requests are matched first and settled into their own wallet ledger.
  // A matched Forex callback must NEVER enter the legacy airtime queue.
  if (MerchantRequestID) {
    try {
      const forexResult = await settleForexCallback({
        merchantRequestId: MerchantRequestID,
        resultCode: ResultCode,
        resultDesc: ResultDesc,
        receipt,
        phone,
        amount,
      });
      if (forexResult.handled) {
        console.log(`Forex deposit ${MerchantRequestID}: ${forexResult.status}`);
        return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
      }
    } catch (error) {
      console.error("Forex callback settlement failed; refusing airtime fallback:", error.message);
      return res.status(500).json({ ResultCode: 1, ResultDesc: "Forex deposit settlement failed" });
    }
  }

  // Existing Webazi Airtime / USSD processing remains unchanged below.
  if (ResultCode === 0) {
    if (!receipt || !phone || amount == null) {
      console.error("Successful STK callback is missing receipt, phone or amount");
      return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
    }

    if (MerchantRequestID && globalOrders[MerchantRequestID]) {
      globalOrders[MerchantRequestID].status = "pending";
      globalOrders[MerchantRequestID].receipt = receipt;
      globalOrders[MerchantRequestID].completedAt = new Date().toISOString();
    }

    if (await receiptExists(receipt)) {
      console.warn(`[DUPLICATE] Receipt ${receipt} already exists — ignoring replay`);
      return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
    }

    try {
      await insertTransaction({
        receipt, phone, amount: Number(amount),
        merchantRequestId: MerchantRequestID || null, status: "pending",
      });
      console.log("✅ PAYMENT CONFIRMED → USSD QUEUE", { receipt, phone, amount: Number(amount) });
    } catch (error) {
      console.error("❌ Failed to save successful STK transaction:", error.message);
    }
    return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
  }

  console.warn(`❌ STK payment failed: ${ResultDesc || "Unknown error"}`);
  if (MerchantRequestID && globalOrders[MerchantRequestID]) {
    globalOrders[MerchantRequestID].status = "failed";
    globalOrders[MerchantRequestID].error = ResultDesc || "Payment failed";
  }

  if (MerchantRequestID) {
    try {
      await insertTransaction({
        receipt: null,
        phone: globalOrders[MerchantRequestID]?.phone || "",
        amount: globalOrders[MerchantRequestID]?.amount || 0,
        merchantRequestId: MerchantRequestID,
        status: "failed",
        failureReason: ResultDesc || "Payment failed",
      });
    } catch (error) {
      console.error("Failed to persist failed STK attempt:", error.message);
    }
  }
  return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
});

router.post("/validation", (req, res) => {
  console.log("📥 C2B validation received");
  return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
});

router.post("/confirmation", async (req, res) => {
  const body = req.body;
  if (!body || Object.keys(body).length === 0) {
    return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
  }
  const { TransAmount, TransID, MSISDN, MerchantRequestID } = body;
  const receipt = String(TransID || "");
  const phone = String(MSISDN || "");
  const amount = Number(TransAmount);

  console.log("📥 C2B confirmation received", { receipt, phone, amount });
  if (!receipt || !phone || !Number.isFinite(amount)) {
    console.error("❌ Invalid C2B confirmation payload");
    return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
  }
  if (await receiptExists(receipt)) {
    console.warn(`[DUPLICATE] C2B receipt ${receipt} already exists`);
    return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
  }
  if (MerchantRequestID && globalOrders[MerchantRequestID]) {
    globalOrders[MerchantRequestID].status = "pending";
    globalOrders[MerchantRequestID].receipt = receipt;
    globalOrders[MerchantRequestID].completedAt = new Date().toISOString();
  }
  try {
    await insertTransaction({ receipt, phone, amount, merchantRequestId: MerchantRequestID || null, status: "pending" });
    console.log("✅ C2B PAYMENT CONFIRMED → USSD QUEUE", { receipt, phone, amount });
  } catch (error) {
    console.error("❌ Failed to save C2B transaction:", error.message);
  }
  return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
});

module.exports = router;
