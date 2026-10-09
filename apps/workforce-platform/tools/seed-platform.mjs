#!/usr/bin/env node
/**
 * Seeds the role/permission baseline (and optionally the first administrator) on
 * whichever adapter is configured, through the repository contract.
 *
 * A MySQL host normally gets this from migrations 001 + 003; the tool is still the
 * supported way to *repair* a host whose seed rows were lost. A file host has no
 * migrations at all, so this is the step that makes a fresh install administrable
 * (see `npm run verify:data`, which fails until it has been run).
 *
 * Idempotent: re-running updates display names and re-applies grants, never
 * duplicates them, and never creates a second administrator.
 *
 * Usage:
 *   node tools/seed-platform.mjs
 *   node tools/seed-platform.mjs --admin-username root --admin-email root@example.com \
 *     --admin-password 'a long administrator password'
 *   WF_BOOTSTRAP_ADMIN_PASSWORD='…' node tools/seed-platform.mjs --admin-username root
 */

import { loadConfig } from "../src/config.js";
import { createStoreFor } from "../src/persistence/index.js";
import { seedPlatformBaseline } from "../src/db/platform-baseline.js";

function parseFlags(entries) {
  const flags = new Map();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry.startsWith("--")) continue;
    const [name, inline] = entry.slice(2).split("=");
    const next = entries[index + 1];
    if (inline !== undefined) flags.set(name, inline);
    else if (next && !next.startsWith("--")) {
      flags.set(name, next);
      index += 1;
    } else flags.set(name, true);
  }
  return flags;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const flags = parseFlags(process.argv.slice(2));
  const config = loadConfig();
  const { store, pool } = await createStoreFor({ config, logger: console });
  try {
    const adminUsername = flags.get("admin-username");
    const adminPassword = flags.get("admin-password") || process.env.WF_BOOTSTRAP_ADMIN_PASSWORD;
    let admin = null;
    if (adminUsername || adminPassword) {
      if (!adminUsername || !adminPassword) throw new Error("Both --admin-username and --admin-password (or WF_BOOTSTRAP_ADMIN_PASSWORD) are required to bootstrap an administrator");
      admin = {
        username: String(adminUsername),
        password: String(adminPassword),
        email: flags.get("admin-email") || null,
        displayName: flags.get("admin-display-name") || String(adminUsername),
      };
    }
    const result = await seedPlatformBaseline(store, { admin, logger: console });
    console.log(`Seeded ${result.roles} role(s), ${result.permissions} permission(s), ${result.grants} grant(s) on the ${store.adapter} adapter.`);
    if (result.admin) console.log(`Administrator "${result.admin.username}" ${result.admin.created ? "created" : "already existed; role re-applied"} (id ${result.admin.id}).`);
    if (result.skipped) console.log(`NOTE ${result.skipped}`);
  } catch (error) {
    console.error(`Seed failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await store.close?.();
    await pool?.end?.();
  }
}
