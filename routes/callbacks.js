const express = require("express");
const { receiptExists, insertTransaction } = require("../db");
const { globalOrders } = require("../utils/orders");

const router = express.Router();

/**
 * STK Push callback
 *
 * IMPORTANT:
 * A successful M-Pesa payment is stored as "pending".
 * "pending" means:
 *   Payment confirmed → waiting for USSD app to deliver airtime.
 *
 * The USSD app changes the transaction to "completed" only
 * after the airtime delivery process succeeds.
 */
router.post("/stk-callback", async (req, res) => {
  const body = req.body;

  if (!body || Object.keys(body).length === 0) {
    return res.status(200).json({
      ResultCode: 0,
      ResultDesc: "Accepted",
    });
  }

  const callback = body?.Body?.stkCallback;

  if (!callback) {
    console.warn(
      "Unrecognized callback payload:",
      JSON.stringify(body)
    );

    return res.status(200).json({
      ResultCode: 0,
      ResultDesc: "Accepted",
    });
  }

  const {
    ResultCode,
    ResultDesc,
    CallbackMetadata,
    MerchantRequestID,
    CheckoutRequestID,
  } = callback;

  // Safaricom only sends CallbackMetadata for successful payments.
  const items = CallbackMetadata?.Item || [];

  const getVal = (name) => {
    return items.find((item) => item.Name === name)?.Value;
  };

  const amount = getVal("Amount");
  const receipt = String(getVal("MpesaReceiptNumber") || "");
  const phone = String(getVal("PhoneNumber") || "");

  console.log("📥 STK callback received");
  console.log("ResultCode:", ResultCode);
  console.log("ResultDesc:", ResultDesc);
  console.log("MerchantRequestID:", MerchantRequestID);
  console.log("CheckoutRequestID:", CheckoutRequestID);
  console.log("Amount:", amount);
  console.log("Phone:", phone);
  console.log("Receipt:", receipt);

  // ---------------------------------------------------------
  // PAYMENT SUCCESS
  // ---------------------------------------------------------

  if (ResultCode === 0) {
    if (!receipt || !phone || amount == null) {
      console.error(
        "❌ Successful STK callback is missing receipt, phone or amount"
      );

      return res.status(200).json({
        ResultCode: 0,
        ResultDesc: "Accepted",
      });
    }

    // Update the temporary in-memory order.
    if (MerchantRequestID && globalOrders[MerchantRequestID]) {
      globalOrders[MerchantRequestID].status = "pending";
      globalOrders[MerchantRequestID].receipt = receipt;
      globalOrders[MerchantRequestID].completedAt =
        new Date().toISOString();

      console.log(
        `💰 Payment confirmed for order ${MerchantRequestID}`
      );
    }

    // Prevent duplicate callback/replay.
    if (await receiptExists(receipt)) {
      console.warn(
        `[DUPLICATE] Receipt ${receipt} already exists — ignoring replay`
      );

      return res.status(200).json({
        ResultCode: 0,
        ResultDesc: "Accepted",
      });
    }

    try {
      /**
       * IMPORTANT:
       *
       * status = 'pending'
       *
       * This makes the transaction visible to:
       *
       * GET /transactions/pending
       *
       * which is what the Webazi USSD app polls.
       */
      await insertTransaction({
        receipt,
        phone,
        amount: Number(amount),
        merchantRequestId: MerchantRequestID || null,
        status: "pending",
      });

      console.log(
        `✅ PAYMENT CONFIRMED → USSD QUEUE`
      );

      console.log(
        `   Receipt: ${receipt}`
      );

      console.log(
        `   Customer: ${phone}`
      );

      console.log(
        `   Airtime: KES ${Number(amount)}`
      );

      console.log(
        `   Status: pending`
      );
    } catch (error) {
      console.error(
        "❌ Failed to save successful STK transaction:",
        error.message
      );
    }

    return res.status(200).json({
      ResultCode: 0,
      ResultDesc: "Accepted",
    });
  }

  // ---------------------------------------------------------
  // PAYMENT FAILED / CANCELLED
  // ---------------------------------------------------------

  console.warn(
    `❌ STK payment failed: ${ResultDesc || "Unknown error"}`
  );

  if (MerchantRequestID && globalOrders[MerchantRequestID]) {
    globalOrders[MerchantRequestID].status = "failed";
    globalOrders[MerchantRequestID].error =
      ResultDesc || "Payment failed";

    console.log(
      `❌ Order ${MerchantRequestID} marked failed`
    );
  }

  // Persist the failure to Supabase, not just the in-memory globalOrders
  // object — this is what survives a server restart/redeploy, so
  // GET /mpesa/order-status still works even if Render restarted between
  // the failed attempt and the customer checking their status.
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

  return res.status(200).json({
    ResultCode: 0,
    ResultDesc: "Accepted",
  });
});

/**
 * C2B Validation
 */
router.post("/validation", (req, res) => {
  console.log("📥 C2B validation received");

  return res.status(200).json({
    ResultCode: 0,
    ResultDesc: "Accepted",
  });
});

/**
 * C2B Confirmation
 *
 * A confirmed C2B payment is also placed into the
 * USSD delivery queue as "pending".
 */
router.post("/confirmation", async (req, res) => {
  const body = req.body;

  if (!body || Object.keys(body).length === 0) {
    return res.status(200).json({
      ResultCode: 0,
      ResultDesc: "Accepted",
    });
  }

  const {
    TransAmount,
    TransID,
    MSISDN,
    MerchantRequestID,
  } = body;

  const receipt = String(TransID || "");
  const phone = String(MSISDN || "");
  const amount = Number(TransAmount);

  console.log("📥 C2B confirmation received");
  console.log("Receipt:", receipt);
  console.log("Phone:", phone);
  console.log("Amount:", amount);

  if (!receipt || !phone || !Number.isFinite(amount)) {
    console.error(
      "❌ Invalid C2B confirmation payload"
    );

    return res.status(200).json({
      ResultCode: 0,
      ResultDesc: "Accepted",
    });
  }

  if (await receiptExists(receipt)) {
    console.warn(
      `[DUPLICATE] C2B receipt ${receipt} already exists`
    );

    return res.status(200).json({
      ResultCode: 0,
      ResultDesc: "Accepted",
    });
  }

  if (MerchantRequestID && globalOrders[MerchantRequestID]) {
    globalOrders[MerchantRequestID].status = "pending";
    globalOrders[MerchantRequestID].receipt = receipt;
    globalOrders[MerchantRequestID].completedAt =
      new Date().toISOString();
  }

  try {
    await insertTransaction({
      receipt,
      phone,
      amount,
      merchantRequestId: MerchantRequestID || null,
      status: "pending",
    });

    console.log(
      `✅ C2B PAYMENT CONFIRMED → USSD QUEUE`
    );

    console.log(
      `   Receipt: ${receipt}`
    );

    console.log(
      `   Customer: ${phone}`
    );

    console.log(
      `   Airtime: KES ${amount}`
    );

    console.log(
      `   Status: pending`
    );
  } catch (error) {
    console.error(
      "❌ Failed to save C2B transaction:",
      error.message
    );
  }

  return res.status(200).json({
    ResultCode: 0,
    ResultDesc: "Accepted",
  });
});

module.exports = router;
