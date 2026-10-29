// Browser capability isolation and HTTP boundaries, with no Wolt requests.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PaymentContextService, paymentSdk } from "../lib/payment-context.js";
import { withStateDir } from "../lib/context.js";
import { serveHttp } from "../lib/remote.js";

const root = mkdtempSync(join(tmpdir(), "wolt-payment-context-"));
const account = join(root, "accounts", "account-one");
const other = join(root, "accounts", "account-two");
const publicUrl = "https://mcp.example";
const service = new PaymentContextService({ stateDir: root, publicUrl, fetchImpl: async url => {
  assert.equal(url, "https://wolt.com/en/discovery");
  return new Response('<script>{"RAVELIN_PK":"publishable_key_test_fixture"}</script>');
} });
const browserInfo = { color_depth: 30, java_enabled: false, language: "en-US", screen_height: 900, screen_width: 1440, time_zone_offset: -60, user_agent: "Browser fixture" };
const quote = () => ({ id: "quote-one", expiresAt: Date.now() + 60000 });
const save = (dir, q) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "order-quote.json"), JSON.stringify(q), { mode: 0o600 }); };
const issue = q => withStateDir(account, () => { save(account, q); return service.issue(q).split("#")[1]; });
const payload = token => ({ token, browserInfo, deviceId: "opaque-sdk-device" });

try {
  save(other, { id: "other-quote", expiresAt: Date.now() + 60000 });
  assert.deepEqual(await service.config(), { publicKey: "publishable_key_test_fixture" });
  assert.match(paymentSdk(), /ravelinjs 2\.3\.0/, "serve the installed, pinned SDK");
  let token = issue(quote());
  assert.equal(statSync(service.file(token)).mode & 0o077, 0, "capability records are private");
  assert(!readFileSync(service.file(token), "utf8").includes(token), "only the capability hash is stored");
  assert.throws(() => service.complete(payload("bad")), /invalid or expired/);
  assert.throws(() => service.complete({ ...payload(token), browserInfo: {} }), /incomplete browser/);
  assert.deepEqual(service.complete(payload(token)), { ok: true });
  assert(!existsSync(service.file(token)), "success consumes the link");
  assert.deepEqual(JSON.parse(readFileSync(join(account, "order-quote.json"))).browserContext, { browserInfo, deviceId: "opaque-sdk-device" });
  assert(!JSON.parse(readFileSync(join(other, "order-quote.json"))).browserContext, "another account is untouched");
  assert.throws(() => service.complete(payload(token)), /invalid or expired/);
  token = issue({ ...quote(), expiresAt: Date.now() - 1 });
  assert.throws(() => service.complete(payload(token)), /expired/);
  token = issue(quote());
  save(account, { ...quote(), id: "replacement" });
  assert.throws(() => service.complete(payload(token)), /replaced/);
  token = issue({ ...quote(), submittedAt: Date.now() });
  assert.throws(() => service.complete(payload(token)), /already submitted/);

  const server = await serveHttp({ buildServer: () => { throw Error("no MCP calls expected"); }, version: "test", port: 0, host: "127.0.0.1", env: { WOLT_HTTP_AUTH: "none", WOLT_STATE_DIR: root, WOLT_PUBLIC_URL: publicUrl, WOLT_RAVELIN_PUBLIC_KEY: "publishable_key_test_fixture" }, log: () => {} });
  try {
    const base = server.url;
    let r = await fetch(`${base}/payment-context`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.equal(r.headers.get("referrer-policy"), "no-referrer");
    assert.match(r.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    assert.equal(r.headers.get("access-control-allow-origin"), null, "browser setup does not inherit MCP's wildcard CORS");
    const html = await r.text();
    assert(html.indexOf("history.replaceState") < html.indexOf("new Ravelin"), "the capability is removed before SDK telemetry starts");
    r = await fetch(`${base}/payment-context/config`);
    assert.deepEqual(await r.json(), { publicKey: "publishable_key_test_fixture" });
    token = issue(quote());
    for (const origin of [null, "https://other.example"]) {
      const headers = { "content-type": "application/json", ...(origin ? { origin } : {}) };
      r = await fetch(`${base}/payment-context`, { method: "POST", headers, body: JSON.stringify(payload(token)) });
      assert.equal(r.status, 403);
    }
    r = await fetch(`${base}/payment-context`, { method: "POST", headers: { origin: publicUrl, "content-type": "application/json" }, body: JSON.stringify(payload(token)) });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true });
    r = await fetch(`${base}/payment-context`, { method: "POST", headers: { origin: publicUrl, "content-type": "application/json" }, body: JSON.stringify(payload(token)) });
    assert.equal(r.status, 400, "replay is rejected at the HTTP boundary too");
  } finally { await server.close(); }
} finally { rmSync(root, { recursive: true, force: true }); }

console.log("payment-context.test.mjs: SDK, account isolation, expiry, replay and same-origin checks pass");
