const express = require("express");
const { db, receiptExists } = require("../db");
const router = express.Router();

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

  const { ResultCode, ResultDesc, CallbackMetadata } = callback;

  if (ResultCode !== 0) {
    console.log(`Payment FAILED/CANCELLED: ${ResultDesc}`);
    return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
  }

  const items = CallbackMetadata?.Item || [];
  const getVal = (name) => items.find((i) => i.Name === name)?.Value;

  const amount = getVal("Amount");
  const receipt = String(getVal("MpesaReceiptNumber"));
  const phone = String(getVal("PhoneNumber"));

  if (receiptExists(receipt)) {
    console.warn(`[DUPLICATE] Receipt ${receipt} already processed — ignoring replay`);
    return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
  }

  try {
    db.prepare(
      `INSERT INTO transactions (receipt, phone, amount, status) VALUES (?, ?, ?, 'pending')`
    ).run(receipt, phone, Number(amount));
    console.log(`Saved pending transaction: KES ${amount} from ${phone}, receipt ${receipt}`);
  } catch (e) {
    console.error("Failed to save transaction:", e.message);
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

  const { TransAmount, TransID, MSISDN } = body;
  const receipt = String(TransID);

  if (receiptExists(receipt)) {
    console.warn(`[DUPLICATE] C2B receipt ${receipt} already processed — ignoring replay`);
    return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
  }

  try {
    db.prepare(
      `INSERT INTO transactions (receipt, phone, amount, status) VALUES (?, ?, ?, 'pending')`
    ).run(receipt, String(MSISDN), Number(TransAmount));
    console.log(`Saved pending C2B transaction: KES ${TransAmount} from ${MSISDN}`);
  } catch (e) {
    console.error("Failed to save C2B transaction:", e.message);
  }

  return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
});

module.exports = router;
