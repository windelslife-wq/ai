import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicScript = readFileSync(path.join(root, "public/js/app.js"), "utf8");
const adminScript = readFileSync(path.join(root, "public/js/admin.js"), "utf8");

function element() {
  const node = { attrs: {}, dataset: {}, children: [], disabled: false, hidden: false, className: "", onclick: null, onsubmit: null };
  let html = "";
  let text = "";
  Object.defineProperties(node, {
    innerHTML: {
      get: () => html,
      set: value => { html = String(value); text = ""; node.children = []; },
    },
    textContent: {
      get: () => text,
      set: value => { text = String(value); html = ""; node.children = []; },
    },
  });
  node.setAttribute = (name, value) => { node.attrs[name] = String(value); };
  node.addEventListener = (name, handler) => { node.listeners ??= {}; (node.listeners[name] ??= []).push(handler); };
  node.classList = { toggle() {} };
  node.insertAdjacentHTML = (_position, value) => { html += String(value); };
  node.append = child => { child.parent = node; node.children.push(child); html += child.textContent; };
  node.remove = () => {
    if (node.parent) node.parent.children = node.parent.children.filter(child => child !== node);
  };
  node.querySelector = selector => selector === "[data-history-error]" ? node.children.find(child => child.dataset.historyError === "true") ?? null : null;
  return node;
}

function runPublic(page, fetch, additions = {}, overrides = {}) {
  const nodes = new Map(["history", "more", "today", "login", "message"].map(id => [id, element()]));
  for (const [id, node] of Object.entries(overrides)) nodes.set(id, node);
  const document = {
    body: { dataset: { page } },
    getElementById: id => nodes.get(id) ?? null,
    createElement: () => element(),
  };
  const context = { document, fetch, Response, URLSearchParams, console, ...additions };
  const execution = runInNewContext(publicScript, context);
  return { nodes, context, execution };
}

function runAdmin(fetch) {
  const nodes = new Map(["heading", "content", "tabs", "logout", "retry-bootstrap", "generate", "stage", "publish", "unpublish"].map(id => [id, element()]));
  const document = {
    querySelector: selector => nodes.get(selector.replace(/^#/, "")) ?? null,
    querySelectorAll: () => [],
  };
  const intervals = [];
  const location = { replaced: [], replace(value) { this.replaced.push(value); } };
  const context = {
    document, fetch, Response, console,
    setInterval(callback) { intervals.push(callback); return intervals.length; },
    clearInterval() {}, confirm: () => true, alert: () => {}, location,
  };
  runInNewContext(adminScript, context);
  return { nodes, context, intervals };
}

async function waitFor(predicate, message = "condition was not reached") {
  for (let i = 0; i < 50; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  assert.fail(message);
}

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ticket = id => ({ id, day: "2026-10-19", result: "PENDING", original_odds: "1.85" });

test("public history exposes API error details and retries the failed first page", async () => {
  let calls = 0;
  const { nodes, execution } = runPublic("history", async () => {
    calls++;
    return calls === 1
      ? jsonResponse({ error: { code: "HISTORY_UNAVAILABLE" } }, 503)
      : jsonResponse({ data: [] });
  });
  await execution;
  assert.equal(nodes.get("history").textContent, "HISTORY_UNAVAILABLE");
  assert.equal(nodes.get("more").textContent, "Retry");
  nodes.get("more").onclick();
  await waitFor(() => calls === 2 && nodes.get("more").textContent === "Load more");
  assert.match(nodes.get("history").innerHTML, /No published tickets yet/);
  assert.equal(nodes.get("more").hidden, true);
});

test("history pagination blocks duplicate requests and clears a transient page error after retry", async () => {
  let resolveFirst;
  let calls = 0;
  const { nodes, execution } = runPublic("history", async () => {
    calls++;
    if (calls === 1) return new Promise(resolve => { resolveFirst = resolve; });
    if (calls === 2) return jsonResponse({ error: { code: "PAGE_TEMPORARILY_UNAVAILABLE" } }, 503);
    return jsonResponse({ data: [ticket(21)] });
  });

  assert.equal(calls, 1);
  nodes.get("more").onclick();
  assert.equal(calls, 1, "a second click during the initial request must not duplicate it");
  resolveFirst(jsonResponse({ data: Array.from({ length: 20 }, (_, index) => ticket(index + 1)) }));
  await execution;
  assert.equal(nodes.get("more").hidden, false);

  nodes.get("more").onclick();
  await waitFor(() => calls === 2 && nodes.get("more").textContent === "Retry");
  const errorNotice = nodes.get("history").children.filter(child => child.dataset.historyError === "true");
  assert.equal(errorNotice.length, 1);
  assert.equal(errorNotice[0].textContent, "PAGE_TEMPORARILY_UNAVAILABLE");

  nodes.get("more").onclick();
  await waitFor(() => calls === 3 && nodes.get("more").textContent === "Load more");
  assert.equal(nodes.get("history").children.filter(child => child.dataset.historyError === "true").length, 0);
  assert.match(nodes.get("history").innerHTML, /Ticket #21/);
});

test("public administrator sign-in rejects a valid non-admin account without redirecting", async () => {
  let destination = "";
  const form = element();
  const button = element(); button.textContent = "Sign in";
  form.querySelector = selector => selector === "button" ? button : null;
  const values = [["email", "member@example.test"], ["password", "a test password"]];
  class TestFormData { [Symbol.iterator]() { return values[Symbol.iterator](); } }
  const fetch = async (url, options = {}) => {
    if (url === "/api/auth/me") return jsonResponse({ error: { code: "NOT_AUTHENTICATED" } }, 401);
    assert.equal(url, "/api/auth/login");
    assert.equal(options.method, "POST");
    return jsonResponse({ user: { role: "MEMBER" } });
  };
  const { nodes, execution } = runPublic("login", fetch, { FormData: TestFormData, location: { replace: value => { destination = value; } } }, { login: form });
  await execution;
  await form.onsubmit({ preventDefault() {} });
  assert.equal(destination, "");
  assert.match(nodes.get("message").textContent, /does not have administrator access/i);
  assert.equal(button.disabled, false);
});

test("admin bootstrap shows connection errors and a working retry control", async () => {
  let calls = 0;
  const { nodes } = runAdmin(async () => {
    calls++;
    return jsonResponse({ error: { message: calls === 1 ? "database unavailable" : "still offline" } }, 503);
  });
  await waitFor(() => nodes.get("retry-bootstrap").onclick !== null);
  assert.equal(nodes.get("heading").textContent, "Connection error");
  assert.match(nodes.get("content").innerHTML, /database unavailable/);

  nodes.get("retry-bootstrap").onclick();
  await waitFor(() => calls === 2 && nodes.get("content").innerHTML.includes("still offline"));
  assert.equal(nodes.get("heading").textContent, "Connection error");
});

test("admin bootstrap explains a signed-in non-admin denial instead of redirecting away", async () => {
  const { nodes, context } = runAdmin(async () => jsonResponse({ user: { role: "MEMBER" } }));
  await waitFor(() => nodes.get("retry-bootstrap").onclick !== null);
  assert.equal(nodes.get("heading").textContent, "Administrator access required");
  assert.match(nodes.get("content").innerHTML, /not an administrator/i);
  assert.match(nodes.get("content").innerHTML, /Administrator sign in/);
  assert.deepEqual(context.location.replaced, []);
});

test("admin generation polling surfaces status failures while generation is still pending", async () => {
  let resolveGeneration;
  const requests = [];
  const fetch = async url => {
    requests.push(url);
    if (url === "/api/auth/me") return jsonResponse({ user: { role: "ADMIN" } });
    if (url === "/api/auth/csrf") return jsonResponse({ csrfToken: "csrf-test" });
    if (url === "/api/admin/dashboard") return jsonResponse({ today: null, generation: { stage: "Ready", status: "IDLE" } });
    if (url === "/api/admin/generate-ticket") return new Promise(resolve => { resolveGeneration = resolve; });
    if (url === "/api/admin/generation-report") return jsonResponse({ error: { message: "polling unavailable" } }, 503);
    throw new Error(`unexpected request ${url}`);
  };
  const { nodes, intervals } = runAdmin(fetch);
  await waitFor(() => nodes.get("generate").listeners?.click?.length === 1);
  const generationPromise = nodes.get("generate").listeners.click[0]({ target: nodes.get("generate") });
  await waitFor(() => intervals.length === 1 && requests.includes("/api/admin/generate-ticket"));
  await intervals[0]();
  assert.equal(nodes.get("stage").textContent, "Generation status unavailable: polling unavailable");

  resolveGeneration(jsonResponse({ error: { message: "generation denied" } }, 403));
  await generationPromise;
  assert.equal(nodes.get("stage").textContent, "generation denied");
  assert.equal(nodes.get("generate").disabled, false);
});
