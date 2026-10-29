# Callback security deployment notes

This branch adds a shared-secret check to all routes mounted under `/callback`.
Do **not** merge/deploy until the following is completed:

1. Generate a high-entropy secret (at least 32 random bytes; for example,
   `openssl rand -hex 32`) and add it as Render environment variable
   `MPESA_CALLBACK_SECRET`. Never commit the value to Git.
2. Update the registered Daraja callback URLs to include the same query
   parameter, e.g. `https://webazi-digital-solutions.onrender.com/callback/stk-callback?token=YOUR_SECRET`.
   Apply the same pattern to any registered `/callback/confirmation` and
   `/callback/validation` URLs.
3. Verify callback delivery with a controlled low-value test and confirm the
   transaction is durably recorded before switching production traffic.
4. Keep the secret private. If it is exposed, rotate the Render variable and
   every registered callback URL together.

The secret check is an additional control, not a replacement for matching
callback request IDs to server-created payment requests, validating successful
payment metadata, idempotent database writes, and reconciliation against
Daraja transaction status.

Other hardening in this branch: callback bodies are no longer logged, request
body sizes are bounded, Express fingerprinting is disabled, and client-facing
error responses no longer expose internal exception details.
