const express = require("express");
const { db, receiptExists } = require("../db");
const router = express.Router();

// In-memory order store (shared with daraja.js)
// In production, use a proper database
const globalOrders = {};

// Export so daraja.js can access the same object
module.exports = router;

// If you still need globalOrders elsewhere, also export it:
module.exports.globalOrders = globalOrders;
// or better: keep a separate export

router.post("/stk-callback", (req, res) => {
  const body = req.body;

  if (!body || Object.keys(body).length === 0) {
    return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
  }

  const callback = body?.Body?.stkCallback;
  if (!callback) {
    console.warn("Unrecognized callback payload:", JSON.stringify(body));
    return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
  }

  const { ResultCode, ResultDesc, CallbackMetadata, MerchantRequestID } = callback;

  // Extract metadata
  const items = CallbackMetadata?.Item || [];
  const getVal = (name) => items.find((i) => i.Name === name)?.Value;

  const amount = getVal("Amount");
  const receipt = String(getVal("MpesaReceiptNumber") || "");
  const phone = String(getVal("PhoneNumber") || "");

  // --- UPDATE IN-MEMORY ORDER STATUS ---
  if (MerchantRequestID && globalOrders[MerchantRequestID]) {
    if (ResultCode === 0) {
      globalOrders[MerchantRequestID].status = "completed";
      globalOrders[MerchantRequestID].receipt = receipt;
      globalOrders[MerchantRequestID].completedAt = new Date().toISOString();
      console.log(`✅ Order ${MerchantRequestID} completed, receipt: ${receipt}`);
    } else {
      globalOrders[MerchantRequestID].status = "failed";
      globalOrders[MerchantRequestID].error = ResultDesc;
      console.log(`❌ Order ${MerchantRequestID} failed: ${ResultDesc}`);
    }
  }

  // Only save to DB if payment was successful
  if (ResultCode === 0 && receipt && receiptExists && !receiptExists(receipt)) {
    try {
      db.prepare(
        `INSERT INTO transactions (receipt, phone, amount, merchant_request_id, status) VALUES (?, ?, ?, ?, 'completed')`
      ).run(receipt, phone, Number(amount), MerchantRequestID || null);
      console.log(`Saved completed transaction: KES ${amount} from ${phone}, receipt ${receipt}`);
    } catch (e) {
      console.error("Failed to save transaction:", e.message);
    }
  } else if (ResultCode === 0 && receipt && receiptExists && receiptExists(receipt)) {
    console.warn(`[DUPLICATE] Receipt ${receipt} already processed — ignoring replay`);
  }

  return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
});

router.post("/validation", (req, res) => {
  return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
});

router.post("/confirmation", (req, res) => {
  const body = req.body;
  if (!body || Object.keys(body).length === 0) {
    return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
  }

  const { TransAmount, TransID, MSISDN, MerchantRequestID } = body;
  const receipt = String(TransID);

  // Update in-memory order if we have the MerchantRequestID
  if (MerchantRequestID && globalOrders[MerchantRequestID]) {
    globalOrders[MerchantRequestID].status = "completed";
    globalOrders[MerchantRequestID].receipt = receipt;
    globalOrders[MerchantRequestID].completedAt = new Date().toISOString();
    console.log(`✅ C2B Order ${MerchantRequestID} completed, receipt: ${receipt}`);
  }

  if (receiptExists && receiptExists(receipt)) {
    console.warn(`[DUPLICATE] C2B receipt ${receipt} already processed — ignoring replay`);
    return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
  }

  try {
    db.prepare(
      `INSERT INTO transactions (receipt, phone, amount, merchant_request_id, status) VALUES (?, ?, ?, ?, 'completed')`
    ).run(receipt, String(MSISDN), Number(TransAmount), MerchantRequestID || null);
    console.log(`Saved completed C2B transaction: KES ${TransAmount} from ${MSISDN}`);
  } catch (e) {
    console.error("Failed to save C2B transaction:", e.message);
  }

  return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
});