# Apache / `.htaccess` guidance for the Node target

- Keep the Node application root and source outside `public_html`. Passenger/Application Manager should route the dedicated staging subdomain to the configured startup file.
- **Do not copy the repository-root `.htaccess`** into the Node document root: it rewrites requests to `index.php` for the legacy PHP application.
- Prefer the rewrite/proxy rules managed by cPanel's Node.js Application Manager. Do not add Passenger directives manually unless the hosting provider requires them and confirms those directives are permitted.
- Do not make `src/`, `database/`, `.env*`, `node_modules/`, logs, or migration files public. Only explicit application routes should be reachable.
- Keep the existing PHP hostname/document root and its `.htaccess` unchanged during coexistence. Use a separate HTTPS staging subdomain for Node validation.

If the host requires a custom Apache rule, get the provider's supported Passenger example and verify that static-file requests, API paths, HTTPS forwarding, and the application startup all work before enabling the rule. No universal `.htaccess` proxy snippet is asserted here because cPanel/Passenger configurations differ by provider.

Two paths are served by the application itself rather than by Apache, so no rewrite is needed for
them under Passenger: `/` and the other marketing paths are composed per request, and `/app/` is
served from `apps/workforce-platform/public/app/` (the built SPA, git-ignored — see
[`docs/INSTALLATION.md`](../../docs/INSTALLATION.md) §5). If `/app/` returns 404 while `/` works, the
bundle was not deployed; no `.htaccess` rule will fix that.
