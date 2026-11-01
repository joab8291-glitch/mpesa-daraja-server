const axios = require("axios");

let cachedToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiry) {
    return cachedToken;
  }

  const { MPESA_BASE_URL, MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET } = process.env;

  const auth = Buffer.from(`${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`).toString("base64");

  const response = await axios.get(
    `${MPESA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${auth}` } }
  );

  cachedToken = response.data.access_token;
  tokenExpiry = now + (parseInt(response.data.expires_in, 10) - 60) * 1000;

  return cachedToken;
}

function generateStkPassword() {
  const { MPESA_SHORTCODE, MPESA_PASSKEY } = process.env;

  const now = new Date();
  const timestamp =
    now.getFullYear().toString() +
    String(now.getMonth() + 1).padStart(2, "0") +
    String(now.getDate()).padStart(2, "0") +
    String(now.getHours()).padStart(2, "0") +
    String(now.getMinutes()).padStart(2, "0") +
    String(now.getSeconds()).padStart(2, "0");

  const password = Buffer.from(`${MPESA_SHORTCODE}${MPESA_PASSKEY}${timestamp}`).toString(
    "base64"
  );

  return { password, timestamp };
}

module.exports = { getAccessToken, generateStkPassword };
