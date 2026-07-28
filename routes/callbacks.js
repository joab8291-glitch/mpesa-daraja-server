const express = require("express");
const router = express.Router();

router.post("/stk-callback", (req, res) => {
  const body = req.body;

  // Ignore empty/ping requests (health checks, monitors) — not real Safaricom callbacks
  if (!body || Object.keys(body).length === 0) {
    return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
  }

  const callback = body?.Body?.stkCallback;

  if (!callback) {
    console.warn("Unrecognized callback payload:", JSON.stringify(body));
    return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
  }

  console.log("STK Callback received:", JSON.stringify(body, null, 2));

  const { ResultCode, ResultDesc, CallbackMetadata } = callback;

  if (ResultCode === 0) {
    const items = CallbackMetadata?.Item || [];
    const getVal = (name) => items.find((i) => i.Name === name)?.Value;

    const amount = getVal("Amount");
    const receipt = getVal("MpesaReceiptNumber");
    const phone = getVal("PhoneNumber");
    const date = getVal("TransactionDate");

    console.log(`Payment SUCCESS: KES ${amount} from ${phone}, receipt ${receipt}, date ${date}`);

    // TODO: update your database — mark the relevant order/invoice as paid
  } else {
    console.log(`Payment FAILED/CANCELLED: ${ResultDesc}`);
    // TODO: mark the order as failed/cancelled in your database
  }

  return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
});

router.post("/validation", (req, res) => {
  console.log("Validation request:", JSON.stringify(req.body, null, 2));
  return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
});

router.post("/confirmation", (req, res) => {
  const body = req.body;

  if (!body || Object.keys(body).length === 0) {
    return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
  }

  console.log("Confirmation received:", JSON.stringify(body, null, 2));

  const { TransAmount, TransID, MSISDN, BillRefNumber } = body;
  console.log(`C2B payment: KES ${TransAmount} from ${MSISDN}, ref ${BillRefNumber}, txn ${TransID}`);

  // TODO: record this payment in your database

  return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
});

module.exports = router;
