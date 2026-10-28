// Ordering, offline: Wolt is a stub shaped like a captured card order. Checks
// the permission gate, the two-phase quote → purchase, every refusal that
// protects the user's money (total mismatch, cap, expiry, price drift,
// unknown option picks, consents, double spend) and the exact purchase payload.
import assert from "node:assert";
import { mkdtempSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const stateDir = mkdtempSync(join(tmpdir(), "wolt-order-"));
process.env.WOLT_STATE_DIR = stateDir;
const { buildServer } = await import("../server.mjs");
const { setFetchImpl } = await import("../lib/http.js");
const { setTokens } = await import("../lib/auth.js");
const { setLocation } = await import("../lib/config.js");
const { placeOrder, readQuote, orderingFromEnv, QUOTE_TTL_MS } = await import("../lib/order.js");

const b64url = (s) => Buffer.from(s).toString("base64url");
setTokens({ accessToken: `${b64url('{"alg":"HS256"}')}.${b64url(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }))}.sig`, refreshToken: "r" });
setLocation({ lat: 41.6, lon: 41.6, label: "test" });

const VENUE = "67d1487ce8ee162ad6471b06";
const CAT = "a858788a7098ec1de13a9c7f";
const world = {
  price1: 1200, options1: [], consents: [], purchaseStatus: 200, bagFee: null, bigVenue: false, weighted2: null,
  calls: [] // [method, path, body]
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
setFetchImpl(async (url, init = {}) => {
  const u = new URL(String(url));
  const method = init.method || "GET";
  const body = init.body ? JSON.parse(init.body) : null;
  world.calls.push([method, u.pathname, body, u.search]);
  const p = u.pathname;
  if (p.endsWith("/pages/baskets")) return json({ baskets: [{ id: "b1", currency: "EUR", venue: { id: VENUE, slug: "soup-place", name: "Soup Place", currency: "EUR", country: "FIN" },
    items: [{ id: "item1", count: 1, name: "Soup", price: 1200, options: world.options1 }, { id: "item2", count: 2, name: "Noodles", price: 2200, options: [], ...(world.weighted2 ? { weighted_item_info: world.weighted2 } : {}) }] }] });
  // A grocery market lists its categories without their items; the item
  // records call names them instead.
  if (p.endsWith("/assortment")) return json({ categories: world.bigVenue ? [{ id: CAT, name: "Mains", slug: "mains" }] : [{ id: CAT, name: "Mains", slug: "mains", items: ["item1", "item2"] }] });
  if (p.endsWith("/assortment/items")) return json({ items: [
    { id: "item1", name: "Soup Of The Day", price: world.price1, checksum: "cs1", alcohol_permille: 0, product_hierarchy_tags: [], restrictions: [], vat_category_code: "FIN-1", vat_percentage: 14, vat_percentage_decimal: "14.0",
      options: [{ id: "bind-side", option_id: "def-side", name: "Side", multi_choice_config: { total_range: { min: 1, max: 1 }, free_selections: 0 } },
                { id: "bind-extra", option_id: "def-extra", name: "Extras", multi_choice_config: { total_range: { min: 0, max: 3 }, free_selections: 1 } }] },
    { id: "item2", name: "Noodles Of The Day", price: 2200, checksum: "cs2", alcohol_permille: 0, product_hierarchy_tags: [], restrictions: [], options: [] }
  ], categories: [{ id: "cat-a", name: null, item_ids: ["item1"] }, { id: "cat-b", name: null, item_ids: ["item1", "item2"] }], options: [
    { id: "def-side", name: "Side", type: "choice", values: [{ id: "v-salad", name: "Salad", price: 0 }, { id: "v-fries", name: "Fries", price: 150 }] },
    { id: "def-extra", name: "Extras", type: "multi_choice", values: [{ id: "v-cheese", name: "Cheese", price: 100 }, { id: "v-bacon", name: "Bacon", price: 250 }] }
  ] });
  if (p.endsWith("/v2/delivery/info")) return json({ results: [
    { id: "addr1", alias: "Home", label_type: "home", location: { address: "Street 1", city: "Town", user_coordinates: { coordinates: [41.61, 41.63] } } },
    { id: "addr2", alias: "Work", label_type: "work", location: { address: "Street 2", city: "Town", user_coordinates: { coordinates: [41.62, 41.64] } } }
  ] });
  if (p.endsWith("/payment_methods")) return json({ cards: [
    { id: { $uuid: "card1" }, type: "card", nickname: "Visa", method_title: "431571******8543", method_code: "visa", is_default: true, valid_for_payments: true },
    { id: { $uuid: "card2" }, type: "card", nickname: "Old", method_title: "411111******1111", method_code: "visa", is_default: false, valid_for_payments: false }
  ], invoices: [] });
  if (p.endsWith("/pages/checkout")) return json({ id: "chk1", payable_amount: 5718,
    purchase_validation: { end_amount: 5718, delivery_price: 118, bag_fee: world.bagFee, credits_amount: null, use_token: null, discounts: [], surcharges: [], offers: [] },
    checkout_rows: [{ template: "amount_row", label: "Item subtotal", amount: { amount: 5600, formatted_amount: "EUR56.00" } }, { template: "price_total_amount_row", label: "Total", price_total_amount: { amount: 5718, formatted_amount: "EUR57.18" } }],
    delivery_configs: [{ method: "homedelivery", schedule: "standard", estimate: { label: "50-60 min" } }],
    payment_breakdown: { unallocated: { amount: 0 } } });
  if (p.endsWith("/post-checkout-config")) {
    // Wolt answers a spelled-out option value list here with 313.
    const listed = body.basket.some((it) => it.options.some((o) => Array.isArray(o.values)));
    if (listed) return json({ error_code: 313, msg: "Invalid parameters" }, 400);
    return json({ required_consents: world.consents });
  }
  if (p.endsWith("/v2/purchases") && world.purchaseStatus === 800) return json({ msg: "Failed to process card", status: "ERR", error_code: 800, params: null }, 400);
  if (p.endsWith("/v2/purchases")) return world.purchaseStatus === 200
    ? json({ results: { id: { $oid: "order1" }, status: "received", amount: 5718, client_pre_estimate: "50-60", currency: "EUR" } })
    : new Response("payment declined", { status: world.purchaseStatus });
  throw new Error(`unexpected request ${method} ${u.href}`);
});

async function connect(ordering) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = buildServer({ remote: true, ordering });
  await server.connect(st);
  const client = new Client({ name: "order-test", version: "1" }, { capabilities: {} });
  await client.connect(ct);
  return { client, close: async () => { await client.close(); await server.close(); } };
}
const purchases = () => world.calls.filter((c) => c[1].endsWith("/v2/purchases"));

// --- no permission: both tools refuse before touching Wolt ---
{
  const { client, close } = await connect(null);
  const { tools } = await client.listTools();
  const place = tools.find((t) => t.name === "place_order");
  assert.equal(place.annotations.destructiveHint, true, "paying is flagged destructive");
  assert.equal(place.annotations.readOnlyHint, false);
  assert.equal(tools.find((t) => t.name === "prepare_order").annotations.readOnlyHint, true, "quoting is read-only for Wolt");
  const r = await client.callTool({ name: "prepare_order", arguments: {} });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /not allowed to place orders/);
  const p = await client.callTool({ name: "place_order", arguments: { quote_id: "6f1e0d8e-0e7a-4f1c-9a4e-2b6c7d8e9f00", total: 1 } });
  assert.match(p.content[0].text, /not allowed to place orders/);
  assert.equal(world.calls.length, 0, "a refused call never reaches Wolt");
  await close();
}

// --- with permission: quote, then every refusal, then the purchase ---
{
  const { client, close } = await connect({ allowed: true, cap: null });
  let r = await client.callTool({ name: "prepare_order", arguments: {} });
  assert.equal(r.isError, undefined, r.content[0].text);
  const q = r.structuredContent;
  assert.equal(q.view, "checkout", "the quote draws the checkout card");
  assert.equal(q.payableAmount, 5718);
  assert.equal(q.currency, "EUR");
  assert.match(q.deliveryTo, /Home/);
  assert.match(q.paidWith, /Visa/);
  assert.equal(q.eta, "50-60 min");
  assert.match(q.quoteId, /^[0-9a-f-]{36}$/);
  assert.equal(statSync(join(stateDir, "order-quote.json")).mode & 0o077, 0, "the quote file is owner-only");
  const quoteReq = world.calls.find((c) => c[1].endsWith("/pages/checkout"))[2].purchase_plan;
  assert.deepEqual(quoteReq.payment_methods.map((m) => m.id), ["card1"], "the default valid card, not the invalid one");
  assert.equal(quoteReq.delivery.delivery_info_id, "addr1", "the home address");
  assert.equal(quoteReq.use_credits_and_tokens, true, "credits apply, as on the website");

  // The wrong total, then the same quote under a cap: no purchase either way.
  r = await client.callTool({ name: "place_order", arguments: { quote_id: q.quoteId, total: 5700 } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /not the quoted 5718/);
  await assert.rejects(placeOrder({ quoteId: q.quoteId, total: 5718, cap: 5000 }), /over the per-order limit/);
  await assert.rejects(placeOrder({ quoteId: "6f1e0d8e-0e7a-4f1c-9a4e-2b6c7d8e9f00", total: 5718 }), /unknown or was replaced/);
  assert.equal(purchases().length, 0);

  // Pending consents stop the purchase too.
  world.consents = [{ id: "terms-2026" }];
  r = await client.callTool({ name: "place_order", arguments: { quote_id: q.quoteId, total: 5718 } });
  assert.match(r.content[0].text, /terms-2026/);
  assert.equal(purchases().length, 0);
  world.consents = [];

  // The real thing.
  r = await client.callTool({ name: "place_order", arguments: { quote_id: q.quoteId, total: 5718 } });
  assert.equal(r.isError, undefined, r.content[0].text);
  const placed = JSON.parse(r.content[0].text);
  assert.equal(placed.ok, true);
  assert.equal(placed.orderId, "order1");
  assert.equal(placed.status, "received");
  assert.equal(placed.total, "57.18 EUR");
  const seq = world.calls.map((c) => c[1]).filter((p) => /post-checkout-config|v2\/purchases/.test(p));
  assert.deepEqual(seq.slice(-2), ["/v1/post-checkout-config", "/v2/purchases"], "consents are checked right before paying");
  const body = purchases()[0][2];
  assert.equal(body.client_nonce, q.quoteId, "the quote id is the idempotency nonce");
  assert.equal(body.checkout_id, "chk1");
  assert.equal(body.end_amount, 5718);
  assert.equal(body.delivery_price, 118);
  assert(!("bag_fee" in body) && !("credits_amount" in body), "fees the quote did not set are left out, as on the website");
  assert.match(world.calls.filter((c) => c[1].endsWith("/assortment/items")).at(-1)[3], /language=en/, "catalog names come in the order's language");
  assert.equal(body.payment_method_id, "card1");
  assert.equal(body.payment_method_type, "card");
  assert.deepEqual(body.delivery_info, { id: { $oid: "addr1" }, use_last_100m_address_picker: true });
  assert.equal(body.client_pre_estimate, "50-60");
  assert.equal(body.type, "purchase");
  assert.equal(body.currency, "EUR");
  assert.equal(body.venue_id, VENUE);
  assert.deepEqual(body.price_shadowing, { end_amount: 5718, delivery_price: 118, bag_fee: null, credits_amount: null, use_token: null, discounts: [], surcharges: [], offers: [] });
  assert.equal(body.items.length, 2);
  assert.deepEqual(body.items[0].name, [{ value: "Soup Of The Day", lang: "en" }]);
  assert.equal(body.items[0].checksum, "cs1");
  assert.equal(body.items[0].configIndex, 0);
  assert.equal(body.items[1].count, 2);
  assert.equal(body.items[1].end_amount, 4400);
  assert.equal(body.items[1].baseprice, 2200);
  assert.equal(body.items[1].configIndex, 1);
  for (const it of body.items) assert(!("category" in it) && !("exclude_from_discounts" in it), "purchase items carry the captured keys only");
  const cfgBody = world.calls.find((c) => c[1].endsWith("/post-checkout-config"))[2];
  assert.equal(cfgBody.basket[0].category, CAT, "the consent check gets the category the website sends");
  assert.equal(cfgBody.country, "FIN");

  // Spending the same quote twice is refused; the record remembers the order.
  r = await client.callTool({ name: "place_order", arguments: { quote_id: q.quoteId, total: 5718 } });
  assert.match(r.content[0].text, /already paid \(order order1\)/);
  assert.equal(purchases().length, 1);
  assert.equal(readQuote().orderId, "order1");

  // A declined purchase keeps the quote retryable and says so.
  world.purchaseStatus = 402;
  r = await client.callTool({ name: "prepare_order", arguments: { address_id: "addr2", tip: 300, comment: "ring twice" } });
  const q2 = r.structuredContent;
  assert.match(q2.deliveryTo, /Work/);
  r = await client.callTool({ name: "place_order", arguments: { quote_id: q2.quoteId, total: 5718 } });
  assert.match(r.content[0].text, /refused the purchase: HTTP 402/);
  const declined = purchases()[1][2];
  assert.equal(declined.tip_amount, 300);
  assert.equal(declined.consumer_comment, "ring twice");
  assert.deepEqual(declined.delivery_info.id, { $oid: "addr2" });
  assert.equal(readQuote().orderId, undefined, "a refused purchase leaves the quote unspent");
  world.purchaseStatus = 200;

  // A card decline says so and blocks retrying the same quote.
  world.purchaseStatus = 800;
  r = await client.callTool({ name: "prepare_order", arguments: {} });
  const qd = r.structuredContent;
  r = await client.callTool({ name: "place_order", arguments: { quote_id: qd.quoteId, total: 5718 } });
  assert.match(r.content[0].text, /card was declined.*Nothing was charged.*Do not retry/s);
  const sent = purchases().length;
  r = await client.callTool({ name: "place_order", arguments: { quote_id: qd.quoteId, total: 5718 } });
  assert.match(r.content[0].text, /declined for this quote/);
  assert.equal(purchases().length, sent, "a declined quote is not sent again");
  world.purchaseStatus = 200;

  // Expiry.
  r = await client.callTool({ name: "prepare_order", arguments: {} });
  await assert.rejects(placeOrder({ quoteId: r.structuredContent.quoteId, total: 5718, now: Date.now() + QUOTE_TTL_MS + 1 }), /expired/);
  assert(!existsSync(join(stateDir, "order-quote.json")), "an expired quote is dropped");

  // Price drift is refused at quote time.
  world.price1 = 1300;
  r = await client.callTool({ name: "prepare_order", arguments: {} });
  assert.match(r.content[0].text, /price of Soup Of The Day changed/);
  world.price1 = 1200;

  // A dish with options: the basket line carries ids only, the purchase
  // spells out type, names and prices from the catalog, as the website does.
  world.options1 = [{ id: "bind-side", values: [{ id: "v-fries", count: 1 }] }, { id: "bind-extra", values: [{ id: "v-cheese", count: 2 }, { id: "v-bacon", count: 1 }] }];
  r = await client.callTool({ name: "prepare_order", arguments: {} });
  assert.equal(r.isError, undefined, r.content[0].text);
  const withOptions = r.structuredContent;
  assert.equal(withOptions.items[0].options, "Side: Fries; Extras: 2× Cheese, Bacon");
  assert.equal(withOptions.items[0].priceWithOptions, 1200 + 150 + 100 + 100, "one extra is free: the dearest pick (Bacon) is dropped, as on the website");
  const quoteWithOptions = world.calls.filter((c) => c[1].endsWith("/pages/checkout")).at(-1)[2].purchase_plan.menu_items[0];
  assert.deepEqual(quoteWithOptions.options, [{ id: "bind-side", values: [{ id: "v-fries", count: 1, price: 150 }] }, { id: "bind-extra", values: [{ id: "v-cheese", count: 2, price: 100 }, { id: "v-bacon", count: 1, price: 250 }] }], "the quote carries the catalog's value prices, which the basket page lacks");
  assert.equal(quoteWithOptions.end_amount, 1550);
  r = await client.callTool({ name: "place_order", arguments: { quote_id: withOptions.quoteId, total: 5718 } });
  assert.equal(r.isError, undefined, r.content[0].text);
  const optItem = purchases().at(-1)[2].items[0];
  assert.deepEqual(optItem.options, [
    { type: "Choice", id: "bind-side", name: [{ value: "Side", lang: "en" }], values: [{ count: 1, name: [{ value: "Fries", lang: "en" }], price: 150, id: "v-fries" }] },
    { type: "Multichoice", id: "bind-extra", name: [{ value: "Extras", lang: "en" }], values: [{ count: 2, name: [{ value: "Cheese", lang: "en" }], price: 100, id: "v-cheese" }, { count: 1, name: [{ value: "Bacon", lang: "en" }], price: 250, id: "v-bacon" }] }
  ], "the captured option shape: binding id, catalog type and names, value prices");
  assert.equal(optItem.baseprice, 1200, "baseprice stays the unit price");
  assert.equal(optItem.end_amount, 1550, "end_amount is the unit with its options");
  assert.equal(optItem.vat_category_code, "FIN-1");
  assert.equal(optItem.vat_percentage_decimal, "14.0");
  assert(!("freeSelections" in optItem.options[1]), "the free-pick bookkeeping stays out of the payload");
  const optCfg = world.calls.filter((c) => c[1].endsWith("/post-checkout-config")).at(-1)[2].basket[0];
  assert.deepEqual(optCfg.options, [
    { type: "Choice", id: "bind-side", name: [{ value: "Side", lang: "en" }], values: { "v-fries": 1 } },
    { type: "Multichoice", id: "bind-extra", name: [{ value: "Extras", lang: "en" }], values: { "v-cheese": 2, "v-bacon": 1 } }
  ], "the consent check gets option values as an id-to-count map, as the website sends them");
  const plainItem = purchases().at(-1)[2].items[1];
  assert(!("vat_category_code" in plainItem) && !("vat_percentage_decimal" in plainItem), "an item without VAT data omits the code and the decimal, as the website does");
  assert.equal(plainItem.vat_percentage, 0);

  // A pick the catalog no longer offers is refused rather than guessed.
  world.options1 = [{ id: "bind-side", values: [{ id: "v-gone", count: 1 }] }];
  r = await client.callTool({ name: "prepare_order", arguments: {} });
  assert.match(r.content[0].text, /"Side" value is no longer offered/);
  world.options1 = [{ id: "bind-gone", values: [{ id: "v-fries", count: 1 }] }];
  r = await client.callTool({ name: "prepare_order", arguments: {} });
  assert.match(r.content[0].text, /no longer in the venue's catalog/);
  world.options1 = [];

  // A grocery basket: the bag fee is echoed to the purchase, and categories
  // the assortment does not list come from the item records.
  world.bagFee = 40; world.bigVenue = true;
  r = await client.callTool({ name: "prepare_order", arguments: {} });
  assert.equal(r.isError, undefined, r.content[0].text);
  const grocery = world.calls.filter((c) => c[1].endsWith("/pages/checkout")).at(-1)[2].purchase_plan.menu_items;
  assert.equal(grocery[0].category_id, "cat-a");
  assert.deepEqual(grocery[0].category_ids, ["cat-a", "cat-b"]);
  assert.equal(grocery[1].category_id, "cat-b");
  r = await client.callTool({ name: "place_order", arguments: { quote_id: r.structuredContent.quoteId, total: 5718 } });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.equal(purchases().at(-1)[2].bag_fee, 40, "a basket with a bag fee says so, or Wolt answers \"Purchase validation error\"");
  world.bagFee = null; world.bigVenue = false;

  // Lines sold by weight are refused until their payload is known.
  world.weighted2 = { count: 1, purchased_weight_in_grams: 500, weighted_item_input_type: "grams" };
  r = await client.callTool({ name: "prepare_order", arguments: {} });
  assert.match(r.content[0].text, /sold by weight/);
  world.weighted2 = null;

  // Over the cap the quote still shows, with a warning the card carries.
  await close();
  const capped = await connect({ allowed: true, cap: 5000 });
  r = await capped.client.callTool({ name: "prepare_order", arguments: {} });
  assert.match(r.structuredContent.warning, /over the per-order limit/);
  r = await capped.client.callTool({ name: "place_order", arguments: { quote_id: r.structuredContent.quoteId, total: 5718 } });
  assert.match(r.content[0].text, /over the per-order limit.*50\.00 EUR/);
  await capped.close();
}

// --- the environment gate for stdio and API tokens ---
assert.deepEqual(orderingFromEnv({}), { allowed: false, cap: null });
assert.deepEqual(orderingFromEnv({ WOLT_ALLOW_ORDERS: "1" }), { allowed: true, cap: null });
assert.deepEqual(orderingFromEnv({ WOLT_ALLOW_ORDERS: "1", WOLT_ORDER_CAP: "50" }), { allowed: true, cap: 5000 });
assert.deepEqual(orderingFromEnv({ WOLT_ALLOW_ORDERS: "1", WOLT_ORDER_CAP: "nope" }), { allowed: true, cap: null });
assert.deepEqual(orderingFromEnv({ WOLT_ALLOW_ORDERS: "yes" }), { allowed: false, cap: null });

setFetchImpl(null);
console.log("order.test.mjs: permission gate, quote, refusals and the purchase payload pass");
