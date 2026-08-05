const express = require("express");
const axios = require("axios");
const { getAccessToken, generateStkPassword } = require("../utils/daraja");

const router = express.Router();

router.post("/stk-push", async (req, res) => {
  try {
    const { phone, amount, accountRef, description } = req.body;

    if (!phone || !amount) {
      return res.status(400).json({ error: "phone and amount are required" });
    }

    const token = await getAccessToken();
    const { password, timestamp } = generateStkPassword();

    const {
      MPESA_BASE_URL,
      MPESA_SHORTCODE,
      MPESA_CALLBACK_URL,
    } = process.env;

    const payload = {
      BusinessShortCode: MPESA_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerPayBillOnline",
      Amount: amount,
      PartyA: phone,
      PartyB: MPESA_SHORTCODE,
      PhoneNumber: phone,
      CallBackURL: MPESA_CALLBACK_URL,
      AccountReference: accountRef || "Webazi",
      TransactionDesc: description || "Payment",
    };

    const response = await axios.post(
      `${MPESA_BASE_URL}/mpesa/stkpush/v1/processrequest`,
      payload,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    return res.status(200).json(response.data);
  } catch (err) {
    console.error("STK Push error:", err.response?.data || err.message);
    return res.status(500).json({
      error: "Failed to initiate STK Push",
      details: err.response?.data || err.message,
    });
  }
});

// STK Push Query – check status of a previous STK request
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

module.exports = router;