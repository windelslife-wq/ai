# WINDELS AI WORKFORCE — Node.js platform foundation

This is the side-by-side Node.js migration target. The existing PHP/CodeIgniter application remains authoritative and deployable; this foundation is **not** a production replacement.

## Current slice

- Node.js `>=22.20.0 <25`.
- `server.js` starts a core `node:http` server. Routing, bounded JSON parsing, static allow-listing, security headers, request IDs, in-memory rate limits and graceful shutdown use Node core modules and internal files—no Express, Fastify or server middleware framework.
- MySQL/MariaDB remains the selected cPanel database, so `mysql2` is required. `bcryptjs` remains necessary to verify imported PHP bcrypt hashes. `pg` is not included: it cannot connect to MySQL.
- The API currently includes health/readiness, login/session/CSRF/logout and the first deny-by-default identity-permission check. The Node product modules are not yet ported.
- `public/` contains a Vanilla JS public landing site, a PWA manifest and a static-only service worker. The worker does not cache `/api/`, authenticated responses or private data.
- `client/` is the React/Vite SPA shell. It includes the initial account sign-in and status surface; domain modules are visibly marked as not yet migrated. `npm run build:client` writes generated files to `public/app/`.
- `native/` contains the Capacitor Android/iOS wrapper configuration. Native sign-in is intentionally disabled until a reviewed native token/refresh/revocation contract and secure Keychain/Android Keystore storage implementation exist.

The client and native build dependencies are isolated from the Node HTTP server package. A complete product migration still requires route, schema, data and UI parity for the backlogged modules.

## Development

From the repository root:

```bash
npm ci
npm ci --prefix apps/workforce-platform/client
npm run check:workforce
npm run build:workforce-client
```

Start the server from the workspace so the static root resolves to `public/`:

```bash
npm run start:workforce-platform
```

The server requires `DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` and a 32-byte-or-longer `SESSION_SECRET`. It can start without immediately connecting to MySQL; readiness reports unavailable until the database and migrations are reachable. The core server does not auto-load `.env`: export the values in your shell, source a private shell-compatible file (`set -a; . ./.env; set +a`), or use cPanel's environment UI. Never commit real secrets.

The Vite development server binds to `0.0.0.0:5173`, uses relative `/api/v1` URLs, and proxies API calls server-side to `http://127.0.0.1:3000` by default. Set `API_PROXY_TARGET` if the API server uses another local port. Browser code never calls localhost.

## Capacitor build boundary

From `native/`, install its dependencies, set `VITE_API_BASE_URL` to the deployed **HTTPS origin**, then run:

```bash
npm run sync
```

`npm run build:web` rejects missing/non-HTTPS/local API origins. The current build remains a shell; sign-in stays disabled. Android/iOS SDK setup, platform project generation, signing, secure credential storage, real native API-origin tests and store release remain future acceptance gates.
