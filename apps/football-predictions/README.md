# WINDELS FOOTBALL PREDICTIONS

Isolated Node.js/Express + MySQL/MariaDB + vanilla web application. **Over 1.5 Goals only.** Bookmaker prices are sourced only from API-Football on the backend. Combined target 2.00–4.00; generation requires an authenticated admin action, publication a separate one; no cron can create a ticket. An empty qualifying set means NO QUALIFYING TICKET, not a forced pick.

## Start

Node 22+, MySQL/MariaDB and an API-Football Pro subscription required. Make a separate database. Configure variables from `.env.example` securely (Node reads process environment, not `.env` automatically). From this directory:

```
npm ci --workspaces=false
node server/migrate.js
read -rsp 'Admin password: ' FP_ADMIN_PASSWORD; echo; export FP_ADMIN_PASSWORD
node server/create-admin.js admin@example.com
unset FP_ADMIN_PASSWORD
node server/jobs/cli.js fixtures
node server/jobs/cli.js statistics
node server/jobs/cli.js odds
node server.js
```

Set `NODE_ENV=production` behind trusted HTTPS proxy. In development only use `NODE_ENV=development`. Open `/login.html`, generate from Dashboard, inspect report, then publish separately. No production test data or default admin password is bundled.

Audit/implementation boundary: [docs/AUDIT.md](docs/AUDIT.md). Architecture/model: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). API: [docs/API.md](docs/API.md). cPanel: [docs/DEPLOYMENT_CPANEL.md](docs/DEPLOYMENT_CPANEL.md). Security: [docs/SECURITY.md](docs/SECURITY.md). Test limitations: [docs/TESTING.md](docs/TESTING.md). Final audit: [docs/FINAL_AUDIT.md](docs/FINAL_AUDIT.md).

**Operational limitations:** Provider coverage/update times vary; no live API/account/DB/cPanel verified here. This is a transparent empirical baseline, not a trained/calibrated AI model. Injuries/H2H/standings/league context are excluded rather than invented. Confidence is evidence strength, not empirical predictive calibration. Accumulator probability assumes independence. Follow the final audit for remaining gaps before treating this as production ready.
