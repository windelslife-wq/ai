/**
 * AEGIS — offline dev runtime bridge (NOT part of the production stack).
 *
 * The repository is a standard CodeIgniter 3 application targeting PHP 8.x +
 * MySQL/MariaDB. This sandbox cannot run a native PHP process or a MySQL
 * server (no package mirrors), so for the live preview we host the SAME
 * CodeIgniter application inside a WebAssembly PHP runtime (php-wasm) with
 * the host filesystem mounted, using CI3's pdo_sqlite dev driver.
 *
 * Each HTTP request gets a FRESH PHP instance (CodeIgniter's front
 * controller is not re-entrant in a persistent interpreter: require_once
 * would skip the whole bootstrap on the second request). Warm WASM
 * instantiation is a few hundred milliseconds — acceptable for a demo.
 *
 * Production deployments use Apache/nginx + php-fpm + MariaDB unchanged.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { loadNodeRuntime, useHostFilesystem } from '@php-wasm/node';
import { PHP, PHPRequestHandler, ProcessIdAllocator } from '@php-wasm/universal';

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';
const APP_ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const PHP_VERSION = process.env.PHP_VERSION ?? '8.2';

const allocator = new ProcessIdAllocator();
let warming = null;

/** Create a fresh, filesystem-mounted PHP instance. */
async function createPhp() {
  const runtime = await loadNodeRuntime(PHP_VERSION, {
    emscriptenOptions: { processId: allocator.claim() },
  });
  const php = new PHP(runtime);
  useHostFilesystem(php);
  return php;
}

/** Verify toolchain + install/upgrade the SQLite schema at boot. */
/**
 * DEV BRIDGE ONLY: the demo sqlite database is gitignored and may be reset at
 * any time, so ensure a clearly-labeled demo operator exists for RBAC demos.
 * Production NEVER auto-creates accounts — admins come from
 * `php index.php tools bootstrap_admin` with real credentials.
 */
async function bootstrapDemoOperator() {
  const php = await createPhp();
  try {
    await php.run({
      code: `<?php
chdir('/home/user/Africa-Mobility');
putenv('AEGIS_DB_DRIVER=pdo_sqlite');
putenv('AEGIS_SQLITE_PATH=/home/user/Africa-Mobility/application/data/aegis.sqlite');
putenv('AEGIS_BOOTSTRAP_ADMIN_EMAIL=demo-operator@aegis.local');
putenv('AEGIS_BOOTSTRAP_ADMIN_PASSWORD=demo-only-long-password-123456');
putenv('AEGIS_BOOTSTRAP_ADMIN_NAME=Demo Operator (dev bridge)');
define('STDIN', fopen('php://stdin', 'r'));
define('STDOUT', fopen('php://stdout', 'w'));
define('STDERR', fopen('php://stderr', 'w'));
$_SERVER['argv'] = ['index.php', 'tools', 'bootstrap_admin'];
$_SERVER['argc'] = 3;
$_SERVER['REMOTE_ADDR'] = '127.0.0.1';
require '/home/user/Africa-Mobility/index.php';
`,
    });
  } catch (e) {
    console.error('[aegis] demo operator bootstrap failed:', e?.message ?? e);
  }
}

async function installSchema() {
  const php = await createPhp();
  const root = APP_ROOT.replaceAll("'", "\\'");
  const result = await php.run({
    code: `<?php
chdir('${root}');
putenv('AEGIS_DB_DRIVER=pdo_sqlite');
putenv('AEGIS_SESSION_DRIVER=database'); // per-request instances share the DB, not the FS session files
putenv('AEGIS_SQLITE_PATH=${root}/application/data/aegis.sqlite');
define('AEGIS_NO_EXIT', true);
require '${root}/tools/install.php';
`,
  }).catch((e) => ({ text: 'INSTALL FAILED: ' + e.message }));
  console.log('[aegis] schema:', result.text.trim().split('\n').slice(-2).join(' | '));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Static assets straight from disk (no PHP round-trip).
  if (url.pathname.startsWith('/assets/')) {
    const file = path.join(APP_ROOT, url.pathname);
    if (file.startsWith(APP_ROOT) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      const types = { '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp' };
      res.setHeader('content-type', types[path.extname(file)] || 'application/octet-stream');
      res.end(fs.readFileSync(file));
      return;
    }
    res.statusCode = 404;
    res.end('not found');
    return;
  }

  const body = await new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(Buffer.alloc(0)));
  });

  try {
    // Fresh interpreter per request (see header comment).
    const php = await createPhp();
    const handler = new PHPRequestHandler({
      php,
      documentRoot: APP_ROOT,
      absoluteUrl: `http://127.0.0.1:${PORT}/`,
    });
    const response = await handler.request({
      method: req.method,
      // Front-controller pattern: always run index.php; the original request
      // target travels in X-Aegis-Orig-Uri (the fastcgi-param pattern).
      url: '/index.php',
      headers: {
        ...req.headers,
        host: req.headers.host ?? `127.0.0.1:${PORT}`,
        'x-aegis-orig-uri': req.url ?? '/',
        // php-wasm's request handler blanks the CGI HTTP_COOKIE value, so the
        // dev bridge carries the raw Cookie header here; index.php restores it.
        'x-aegis-cookie': req.headers.cookie ?? '',
      },
      body: body.length ? body : undefined,
    });
    if (response.httpStatusCode >= 400) {
      console.error('[aegis]', req.method, req.url, '->', response.httpStatusCode,
        '| php errors:', (response.errors || '').slice(0, 400) || '(none)',
        '| body:', Buffer.from(response.bytes ?? []).toString().slice(0, 300));
    }
    res.writeHead(response.httpStatusCode, response.headers);
    res.end(Buffer.from(response.bytes));
  } catch (err) {
    console.error('[aegis] request failed:', err?.message ?? err);
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('AEGIS runtime error: ' + (err?.message ?? err));
  }
});

await installSchema();
startSimBridgeMonitor();

/* -------------------------------------------------------------------------
 * SIMULATED MT5 BRIDGE — offline demo only (never part of production).
 *
 * The demo cannot reach a real MetaTrader terminal, so when an operator
 * enables "Simulated MT5 bridge" in Broker Center, this in-process mock
 * speaks the EXACT documented bridge contract (python-services/mt5-bridge)
 * with in-memory state on 127.0.0.1. Every surface labels it SIMULATION:
 *   - /health reports { simulated: true }
 *   - the PHP connector surfaces that flag in its status
 *   - Broker Center / Execution Center show a SIMULATION banner
 * It is enabled by a marker file (application/data/mt5-demo.json) that the
 * front controller translates into AEGIS_MT5_* env vars — and only inside
 * this dev bridge (X-Aegis-Orig-Uri context). Production never reads it.
 * ------------------------------------------------------------------------ */
const SIM_PORT = Number(process.env.AEGIS_SIM_BRIDGE_PORT ?? 8790);
const SIM_MARKER = path.join(APP_ROOT, 'application/data/mt5-demo.json');
let simServer = null;
let sim = null;

const SIM_SYMBOLS = {
  EURUSD: { base: 1.0842, spread: 0.00014, volume: 1 },
  GBPUSD: { base: 1.2703, spread: 0.00018, volume: 1 },
  USDJPY: { base: 149.32, spread: 0.02, volume: 1 },
  XAUUSD: { base: 2385.5, spread: 0.36, volume: 1 },
  BTCUSD: { base: 64210, spread: 14, volume: 1 },
};

function simFreshState() {
  return { nextTicket: 7001, balance: 10000, positions: [], pending: [], history: [] };
}

function simMid(symbol) {
  const cfg = SIM_SYMBOLS[symbol];
  const t = Date.now() / 1000;
  const drift = Math.sin(t / 97 + symbol.length * 1.7) * 0.004; // ±0.4% slow wave
  return cfg.base * (1 + drift);
}

function simQuote(symbol) {
  const half = SIM_SYMBOLS[symbol].spread / 2;
  const mid = simMid(symbol);
  return { bid: mid - half, ask: mid + half, mid };
}

function readMarker() {
  try {
    const m = JSON.parse(fs.readFileSync(SIM_MARKER, 'utf8'));
    return m && m.enabled === true && typeof m.token === 'string' && m.token.length >= 16 ? m : null;
  } catch {
    return null;
  }
}

function startSimBridgeMonitor() {
  setInterval(() => {
    const active = readMarker() !== null;
    if (active && !simServer) {
      sim = simFreshState();
      simServer = http.createServer(simHandler);
      simServer.listen(SIM_PORT, '127.0.0.1', () =>
        console.log(`[aegis] SIMULATED MT5 bridge (demo) listening on 127.0.0.1:${SIM_PORT}`)
      );
    } else if (!active && simServer) {
      simServer.close();
      simServer = null;
      sim = null;
      console.log('[aegis] simulated MT5 bridge stopped');
    }
  }, 1000).unref();
}

function simJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

async function simHandler(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${SIM_PORT}`);
  const marker = readMarker();
  if (!marker) return simJson(res, 503, { ok: false, error: 'simulated bridge disabled' });
  const auth = req.headers.authorization ?? '';
  const authed = req.method === 'GET' && url.pathname === '/health' || auth === `Bearer ${marker.token}`;
  if (!authed) return simJson(res, 401, { ok: false, error: 'invalid bridge token' });

  const seg = url.pathname.split('/').filter(Boolean); // ['v1', ...]
  const send = (data) => simJson(res, 200, { ok: true, data });
  const fail = (code, error) => simJson(res, code, { ok: false, error });
  const nowIso = () => new Date().toISOString();

  if (url.pathname === '/health') {
    // Health is the ONE unwrapped endpoint in the bridge contract.
    return simJson(res, 200, { ok: true, version: 'sim-1.0.0', tradingEnabled: true, accountType: 'demo', simulated: true });
  }
  if (seg[0] !== 'v1') return fail(404, 'not found');

  if (req.method === 'GET' && seg[1] === 'account') {
    const unrealized = sim.positions.reduce((acc, p) => acc + simPositionPnl(p), 0);
    const margin = sim.positions.reduce((acc, p) => acc + p.volume * p.entry * 0.033, 0);
    const equity = sim.balance + unrealized;
    return send({
      accountId: 'SIM-7001', currency: 'USD', balance: round2(sim.balance), equity: round2(equity),
      margin: round2(margin), freeMargin: round2(equity - margin), leverage: 30, timestamp: nowIso(),
    });
  }
  if (req.method === 'GET' && seg[1] === 'quotes') {
    const symbol = decodeURIComponent(seg[2] ?? '').toUpperCase();
    if (!SIM_SYMBOLS[symbol]) return fail(404, `symbol ${symbol} not available`);
    const q = simQuote(symbol);
    return send({ symbol, bid: q.bid, ask: q.ask, timestamp: nowIso() });
  }
  if (req.method === 'GET' && seg[1] === 'candles') {
    const symbol = decodeURIComponent(seg[2] ?? '').toUpperCase();
    if (!SIM_SYMBOLS[symbol]) return fail(404, `symbol ${symbol} not available`);
    const limit = Math.min(1000, Math.max(10, Number(url.searchParams.get('limit') ?? 200)));
    const candles = [];
    const step = 3600;
    const nowHour = Math.floor(Date.now() / 1000 / step) * step;
    for (let i = limit - 1; i >= 0; i--) {
      const t = nowHour - i * step;
      const mid = SIM_SYMBOLS[symbol].base * (1 + Math.sin(t / 9000 + symbol.length) * 0.01);
      const range = mid * 0.002;
      candles.push({
        t: new Date(t * 1000).toISOString(), o: mid, h: mid + range, l: mid - range,
        c: mid + Math.sin(t / 3000) * range / 2, v: 80 + Math.round(40 * Math.abs(Math.sin(t / 5000))),
      });
    }
    return send(candles);
  }
  if (req.method === 'GET' && seg[1] === 'positions') {
    return send(sim.positions.map((p) => ({
      ticket: p.ticket, symbol: p.symbol, side: p.side === 'BUY' ? 'LONG' : 'SHORT',
      volume: p.volume, entry: p.entry, stopLoss: p.stopLoss, takeProfit: p.takeProfit,
      profit: round2(simPositionPnl(p)), openedAt: p.openedAt,
    })));
  }
  if (req.method === 'GET' && seg[1] === 'orders') {
    return send(sim.pending.map((o) => ({
      ticket: o.ticket, symbol: o.symbol, side: o.side, type: 'LIMIT', volume: o.volume,
      price: o.price, stopLoss: o.stopLoss, takeProfit: o.takeProfit, placedAt: o.placedAt,
    })));
  }
  if (req.method === 'GET' && seg[1] === 'history') {
    return send(sim.history.slice(0, Math.max(1, Math.min(500, Number(url.searchParams.get('limit') ?? 100)))));
  }

  // ---- trading endpoints ----
  if (req.method === 'POST' && seg[1] === 'orders' && seg.length === 2) {
    const body = await readBody(req).then(JSON.parse).catch(() => null);
    if (!body || !['BUY', 'SELL'].includes(body.action) || !['MARKET', 'LIMIT'].includes(body.type)) {
      return fail(400, 'invalid order body');
    }
    const symbol = String(body.symbol ?? '').toUpperCase();
    if (!SIM_SYMBOLS[symbol]) return fail(400, `symbol ${symbol} is not available`);
    if (!(body.volume > 0)) return fail(400, 'volume must be positive');
    const q = simQuote(symbol);
    const ticket = sim.nextTicket++;
    if (body.type === 'LIMIT') {
      if (!(body.price > 0)) return fail(400, 'LIMIT orders require a positive price');
      sim.pending.push({
        ticket, symbol, side: body.action, volume: body.volume, price: body.price,
        stopLoss: body.stopLoss ?? null, takeProfit: body.takeProfit ?? null, placedAt: nowIso(),
      });
      return send({ ticket, price: body.price, placedAt: nowIso() });
    }
    const fill = body.action === 'BUY' ? q.ask : q.bid;
    sim.positions.push({
      ticket, symbol, side: body.action, volume: body.volume, entry: fill,
      stopLoss: body.stopLoss ?? null, takeProfit: body.takeProfit ?? null, openedAt: nowIso(),
    });
    return send({ ticket, price: fill, placedAt: nowIso() });
  }
  if (req.method === 'POST' && seg[1] === 'orders' && seg[3] === 'modify') {
    const ticket = Number(seg[2]);
    const body = await readBody(req).then(JSON.parse).catch(() => ({}));
    const target = sim.positions.find((p) => p.ticket === ticket) ?? sim.pending.find((p) => p.ticket === ticket);
    if (!target) return fail(404, `ticket ${ticket} not found`);
    if (body.stopLoss !== undefined) target.stopLoss = body.stopLoss;
    if (body.takeProfit !== undefined) target.takeProfit = body.takeProfit;
    return send({ ticket });
  }
  if (req.method === 'POST' && seg[1] === 'orders' && seg[3] === 'cancel') {
    const ticket = Number(seg[2]);
    const idx = sim.pending.findIndex((p) => p.ticket === ticket);
    if (idx === -1) return fail(404, `pending order ${ticket} not found`);
    sim.pending.splice(idx, 1);
    return send({ ticket });
  }
  if (req.method === 'POST' && seg[1] === 'positions' && seg[3] === 'close') {
    const ticket = Number(seg[2]);
    const idx = sim.positions.findIndex((p) => p.ticket === ticket);
    if (idx === -1) return fail(404, `position ${ticket} not found`);
    const p = sim.positions.splice(idx, 1)[0];
    const q = simQuote(p.symbol);
    const exit = p.side === 'BUY' ? q.bid : q.ask;
    const pnl = simPositionPnl(p, exit);
    sim.balance += pnl;
    sim.history.unshift({
      ticket: p.ticket, symbol: p.symbol, side: p.side === 'BUY' ? 'LONG' : 'SHORT',
      volume: p.volume, entry: p.entry, exit, profit: round2(pnl), openedAt: p.openedAt, closedAt: nowIso(),
    });
    return send({ ticket, price: exit, profit: round2(pnl) });
  }
  return fail(404, 'not found');
}

function simPositionPnl(p, forcedExit) {
  const q = simQuote(p.symbol);
  const exit = forcedExit ?? (p.side === 'BUY' ? q.mid - SIM_SYMBOLS[p.symbol].spread / 2 : q.mid + SIM_SYMBOLS[p.symbol].spread / 2);
  return (p.side === 'BUY' ? exit - p.entry : p.entry - exit) * p.volume;
}

function round2(v) { return Math.round(v * 100) / 100; }

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString() || '{}'));
    req.on('error', () => resolve('{}'));
  });
}

await bootstrapDemoOperator();
server.listen(PORT, HOST, () => {
  console.log(`[aegis] CodeIgniter 3 app serving on http://${HOST}:${PORT} (WASM PHP ${PHP_VERSION}, sqlite dev driver)`);
});
