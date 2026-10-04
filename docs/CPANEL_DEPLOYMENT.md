# Portable cPanel deployment (no terminal required)

This PHP/CodeIgniter deployment is designed for this exact flow:

```text
Upload ZIP → create MySQL database → import SQL in phpMyAdmin → edit .env → open site
```

It does **not** require SSH, Terminal, Composer, Node.js, npm, Docker, a migration command, or an installer command. The separate `apps/` Node projects are development/source projects and are not part of the cPanel PHP deployment package.

## 1. Upload

1. In **cPanel → File Manager**, open the domain document root (usually `public_html`).
2. Upload `application-deployment.zip`.
3. Select the ZIP and choose **Extract**.
4. If your host extracts into an extra directory, move the extracted contents into the domain document root using File Manager.

The ZIP already contains CodeIgniter and every PHP dependency required by this application. Do not run Composer or npm.

## 2. Create a database

In **cPanel → MySQL Databases**:

1. Create a database.
2. Create a database user and password.
3. Add that user to the database.
4. Select **ALL PRIVILEGES**.

Use the full cPanel-prefixed database and user names in `.env`.

## 3. Import the complete database

1. Open **cPanel → phpMyAdmin**.
2. Select the newly created database.
3. Choose **Import**.
4. Select `database/production.sql` from the extracted application files.
5. Click **Import** and wait for the success message.

`production.sql` contains tables, indexes, access-control roles and permissions, default platform state, lookup data, and the initial administrator. No SQL migration or seed command follows this import.

## 4. Configure `.env`

In File Manager, copy/rename `.env.example` to `.env`, then edit it. At minimum set:

```ini
CI_ENV=production
VP_BASE_URL=https://yourdomain.com/
VP_DB_HOST=localhost
VP_DB_PORT=3306
VP_DB_NAME=YOUR_CPANEL_DATABASE
VP_DB_USER=YOUR_CPANEL_DATABASE_USER
VP_DB_PASS=YOUR_DATABASE_PASSWORD
VP_ENCRYPTION_KEY=YOUR_EXISTING_ENCRYPTION_KEY
VP_AUTH_SECRET=YOUR_EXISTING_AUTH_SECRET
```

For a move between cPanel accounts, preserve `VP_ENCRYPTION_KEY` and `VP_AUTH_SECRET`. Do not generate replacement values merely because the domain or server changed.

The bundled dotenv loader reads this file at application startup. No hidden generated secrets file is required.

Optional SEO settings (`VP_SITE_NAME`, `VP_SITE_DESCRIPTION`, `VP_SITE_KEYWORDS`,
`VP_ROBOTS`, `VP_OG_IMAGE`) and the public assistant (`AI_CHAT_*`) are also
read from `.env`. Leave `AI_CHAT_ENABLED=0` to use the safe built-in product
Guide; enable it only with a server-side approved AI provider key.

## 5. Writable directories

Using **File Manager → Change Permissions**, ensure the web-server user can write to these directories. Standard cPanel permissions of `0755` normally work; use `0775` only if the host requires it:

```text
application/cache/
application/logs/
runtime/sessions/
assets/uploads/
```

No `chmod`, `chown`, or terminal command is necessary.

## 6. Open the website

Open `https://yourdomain.com/`. Root `.htaccess` is included for CodeIgniter routing and prevents HTTP access to `.env`, database exports, runtime, tests, and tools.

## Initial administrator

The complete production database includes this initial account so CLI bootstrapping is never required:

```text
Email:    admin@example.com
Password: ChangeMe!2026
```

Log in immediately and change/restrict this account before allowing public access. For a private migration, retain the existing user rows and credentials by importing a database export from the working installation instead.

## cPanel-only acceptance checklist

- [ ] Files uploaded and extracted through File Manager
- [ ] Database/user created through MySQL Databases
- [ ] `database/production.sql` imported with phpMyAdmin
- [ ] `.env` created and database/domain values edited in File Manager
- [ ] Writable folders adjusted in File Manager if the host requires it
- [ ] Homepage loads
- [ ] Administrator signs in
- [ ] Sessions, authentication, settings, and routing work
- [ ] No CLI, installer, migration, Composer, Node, npm, or Docker command was used
