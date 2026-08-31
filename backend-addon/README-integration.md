[README-integration.md](https://github.com/user-attachments/files/31639310/README-integration.md)
# Integrating agents+subscriptions into webazi-digital-solutions

1. Copy `db.js`, `agentsRoutes.js`, `adminRoutes.js` into your existing
   `mpesa-daraja-server` repo (e.g. a new `backend-addon/` folder).
2. `npm install better-sqlite3`
3. In your main server file (e.g. `index.js` / `app.js`):
   ```js
   const agentsRoutes = require('./backend-addon/agentsRoutes');
   const adminRoutes = require('./backend-addon/adminRoutes');
   app.use('/agents', agentsRoutes);
   app.use('/admin', adminRoutes);
   ```
4. On Render, add an environment variable `ADMIN_API_KEY` — generate any
   long random string. Put the SAME value into the Admin app's config
   (see webazi-admin-app/app.config.ts). Never put this key in the
   Agent or Free-access app builds.
5. ⚠️ Disk note: Render's default web-service disk is wiped on
   redeploy. For the agents.db file to survive deploys, either:
   - Attach a Render **Persistent Disk** to this service, set
     `AGENTS_DB_PATH=/var/data/agents.db` (mount path) as an env var, or
   - Swap `db.js` for Postgres later (all other files only call the
     functions this file exports, so nothing else needs to change).
6. Redeploy. Test with:
   ```
   curl -X POST https://webazi-digital-solutions.onrender.com/agents/register \
     -H "Content-Type: application/json" \
     -d '{"notificationNumber":"0712345678","passwordHashClient":"test","deviceId":"dev1"}'

   curl https://webazi-digital-solutions.onrender.com/admin/agents \
     -H "x-admin-key: YOUR_ADMIN_API_KEY"
   ```
