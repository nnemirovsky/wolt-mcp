// The inline-card layer, offline: the ui:// resource is registered and
// readable, exactly the render tools point at it, their results carry
// structuredContent tagged with a view, and image references of every shape
// Wolt uses resolve to a URL.
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

process.env.WOLT_STATE_DIR = mkdtempSync(join(tmpdir(), "wolt-ui-"));
const { buildServer } = await import("../server.mjs");
const { rich, imageUrlOf, RENDER_TOOLS, UI_RESOURCE_URI, UI_MIME, IMAGE_HOSTS, IMAGE_HINT } = await import("../lib/ui.js");

assert.equal(imageUrlOf("https://imageproxy.wolt.com/a"), "https://imageproxy.wolt.com/a");
assert.equal(imageUrlOf({ url: "https://imageproxy.wolt.com/b", blurhash: "x" }), "https://imageproxy.wolt.com/b");
assert.equal(imageUrlOf([{ url: "https://imageproxy.wolt.com/c" }, { url: "https://imageproxy.wolt.com/d" }]), "https://imageproxy.wolt.com/c");
assert.equal(imageUrlOf([]), null);
assert.equal(imageUrlOf(null), null);
assert.equal(imageUrlOf({ nope: 1 }), null);

const r = rich("products", { query: "milk", items: [{ itemId: "1" }] });
assert.deepEqual(JSON.parse(r.content[0].text), { query: "milk", items: [{ itemId: "1" }] }, "the text is the plain JSON the model always read");
assert.deepEqual(r.structuredContent, { view: "products", query: "milk", items: [{ itemId: "1" }] }, "structuredContent adds the view");

// Through a real client, in memory.
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const server = buildServer({ remote: true });
await server.connect(serverTransport);
const client = new Client({ name: "ui-test", version: "1" }, { capabilities: {} });
await client.connect(clientTransport);

const { resources } = await client.listResources();
const res = resources.find((x) => x.uri === UI_RESOURCE_URI);
assert(res, "the cards resource is listed");
assert.equal(res.mimeType, UI_MIME);
assert.equal(res._meta?.ui?.prefersBorder, true);
assert.deepEqual(res._meta?.ui?.csp?.resourceDomains, IMAGE_HOSTS, "image hosts are allowlisted for the widget");
assert.deepEqual(res._meta?.["openai/widgetCSP"]?.resource_domains, IMAGE_HOSTS);

const read = await client.readResource({ uri: UI_RESOURCE_URI });
const html = read.contents[0].text;
assert.equal(read.contents[0].mimeType, UI_MIME);
assert.match(html, /^<!doctype html>/i);
assert.match(html, /"ui\/initialize"/, "speaks the MCP Apps handshake");
assert.match(html, /ui\/notifications\/tool-result/);
assert.match(html, /window\.openai/, "and ChatGPT's globals as a fallback");
for (const view of ["products", "dishes", "menu", "venues", "venue", "plan", "baskets", "checkout"]) {
  assert.match(html, new RegExp(`case "${view}"`), `renders the ${view} view`);
}
assert.match(html, /prefers-color-scheme: dark/, "follows the host's dark mode");

const { tools } = await client.listTools();
for (const t of tools) {
  const isRender = !!RENDER_TOOLS[t.name];
  assert.equal(t._meta?.ui?.resourceUri, isRender ? UI_RESOURCE_URI : undefined, `${t.name} ${isRender ? "renders cards" : "stays text-only"}`);
  assert.equal(t._meta?.["openai/outputTemplate"], isRender ? UI_RESOURCE_URI : undefined);
  assert.equal(t.description.endsWith(IMAGE_HINT), isRender, `${t.name}: ${isRender ? "tells the model the photos are Wolt's" : "carries no image hint"}`);
  if (isRender) {
    assert.equal(typeof t._meta["openai/toolInvocation/invoking"], "string");
    assert.equal(t.annotations.readOnlyHint, true, `${t.name}: only read-only tools render cards`);
  }
}
assert.equal(tools.find((t) => t.name === "get_wolt_profile")._meta["openai/profile"], true, "the profile marker survives the merge");
assert(!tools.find((t) => t.name === "add_to_cart")._meta, "writes carry no UI");

await client.close();
await server.close();
console.log(`ui.test.mjs: cards resource served, ${Object.keys(RENDER_TOOLS).length} render tools linked, image refs resolve`);
