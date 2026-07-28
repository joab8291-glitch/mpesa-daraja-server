const express = require("express");
const router = express.Router();

router.post("/stk-callback", (req, res) => {
  console.log("STK Callback received:", JSON.stringify(req.body, null, 2));

  const callback = req.body?.Body?.stkCallback;

  if (!callback) {
    console.warn("Unexpected callback payload shape");
    return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
  }

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
  console.log("Confirmation received:", JSON.stringify(req.body, null, 2));

  const { TransAmount, TransID, MSISDN, BillRefNumber } = req.body;
  console.log(`C2B payment: KES ${TransAmount} from ${MSISDN}, ref ${BillRefNumber}, txn ${TransID}`);

  // TODO: record this payment in your database

  return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
});

module.exports = router;
