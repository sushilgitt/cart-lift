/**
 * QA pass for docs/TESTING.md Phases 4, 5, 6, 11.2 and 11.6 — everything that
 * can be simulated without a real store. Drives the real built widget
 * (happy-dom) and the real Discount Function.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import { describe, expect, test } from "vitest";

import { cartLinesDiscountsGenerateRun } from "../../extensions/cartlift-discount/src/cart_lines_discounts_generate_run";
import { buildFunctionConfig, buildGiftConfig, buildStorefrontConfig, buildTranslations, isLive } from "./sync.server";
import { newBar, normalizeConfig, type DealTypeKey } from "./deals";

type Json = Record<string, unknown>;

const widget = readFileSync(
  fileURLToPath(new URL("../../extensions/cartlift-widget/assets/cartlift.js", import.meta.url)),
  "utf8",
);

const TEE = {
  id: 1,
  title: "Tee",
  handle: "tee",
  variants: [{ id: 11, title: "S", price: 2000, compare_at_price: null, available: true }],
};

/** A deal row the way Prisma returns it. */
function row(id: string, o: Partial<Json> = {}, bars = [newBar({ id: `${id}-1`, qty: 1 }), newBar({ id: `${id}-2`, qty: 2, discountType: "percentage", discountValue: 10 })]) {
  return {
    id,
    shopId: "s",
    name: id,
    type: "QUANTITY_BREAK" as DealTypeKey,
    status: "ACTIVE",
    priority: 0,
    targetType: "ALL",
    products: [],
    collections: [],
    startsAt: null,
    endsAt: null,
    config: normalizeConfig({ bars }, "QUANTITY_BREAK"),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...o,
  } as never;
}

const SHOP = { id: "s", domain: "s.myshopify.com", settings: {} } as never;

interface PageOptions {
  product?: Json;
  collections?: number[];
  country?: string;
  url?: string;
  /** Page markup; `{data}` is where the data block(s) go. */
  body?: string;
  blocks?: ("auto" | "block")[];
  /** How many times the theme loads cartlift.js (embed + app block = 2). */
  loads?: number;
  beaconThrows?: boolean;
  i18n?: Json | null;
}

const DAWN_FORM = (variant = 11) => `
  <section class="shopify-section">
    <form action="/cart/add" class="product-form">
      <input type="hidden" name="id" value="${variant}">
      <div class="product-form__quantity"><input name="quantity" value="1"></div>
      <div class="product-form__buttons"><button type="submit" name="add">Add</button><div class="shopify-payment-button"></div></div>
    </form>
  </section>`;

function page(config: Json, o: PageOptions = {}) {
  const window = new Window({ url: o.url ?? "https://shop.test/products/tee" });
  const document = window.document;
  const posts: string[] = [];
  Object.assign(window, {
    fetch: async (url: string) => {
      posts.push(String(url));
      if (o.beaconThrows && String(url).includes("/api/events")) throw new Error("blocked by client");
      return { ok: true, json: async () => ({ items: [] }) };
    },
    Shopify: { currency: { rate: "1.0" }, routes: { root: "/" } },
    alert: () => {},
  });
  (window.navigator as unknown as { sendBeacon: () => boolean }).sendBeacon = () => {
    if (o.beaconThrows) throw new Error("blocked by client");
    return true;
  };
  document.body.innerHTML = o.body ?? DAWN_FORM();
  for (const placement of o.blocks ?? ["auto"]) {
    const data = document.createElement("script");
    data.type = "application/json";
    data.setAttribute("data-cartlift-data", "1");
    data.textContent = JSON.stringify({
      config,
      product: o.product ?? TEE,
      collections: o.collections ?? [],
      moneyFormat: "${{amount}}",
      shop: "s.myshopify.com",
      country: o.country ?? "US",
      i18n: o.i18n ?? null,
      placement,
    });
    document.body.appendChild(data);
  }
  const themeSubmits: number[] = [];
  const form = document.querySelector("form");
  form?.addEventListener("submit", () => themeSubmits.push(1));
  for (let i = 0; i < (o.loads ?? 1); i++) window.eval(widget);
  const submit = () => {
    const event = new window.Event("submit", { bubbles: true, cancelable: true });
    form!.dispatchEvent(event);
    return event.defaultPrevented;
  };
  return { window, document, form, submit, themeSubmits, posts };
}

/** One line of `qty` units of product `productId`, through the real Function. */
function checkout(fnConfig: ReturnType<typeof buildFunctionConfig>, o: { productId: number; qty: number; collections?: number[]; country?: string | null; deal?: string }) {
  const result = cartLinesDiscountsGenerateRun({
    presentmentCurrencyRate: "1.0",
    localization: o.country === null ? null : { country: { isoCode: o.country ?? "US" } },
    cart: {
      lines: [
        {
          id: "gid://shopify/CartLine/1",
          quantity: o.qty,
          cost: { amountPerQuantity: { amount: "20.0" } },
          deal: o.deal ? { value: o.deal } : null,
          arm: null,
          bar: null,
          gift: null,
          upsell: null,
          bundle: null,
          sellingPlanAllocation: null,
          merchandise: {
            __typename: "ProductVariant",
            id: `gid://shopify/ProductVariant/${o.productId}1`,
            product: {
              id: `gid://shopify/Product/${o.productId}`,
              inCollections: (fnConfig.collectionIds ?? []).map((c) => ({
                collectionId: c,
                isMember: (o.collections ?? []).some((n) => c.endsWith(`/${n}`)),
              })),
              complementary: null,
            },
          },
        },
      ],
    },
    discount: { discountClasses: ["PRODUCT"], metafield: { jsonValue: fnConfig } },
  } as never);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((result.operations[0] as any)?.productDiscountsAdd?.candidates ?? []) as { message: string }[];
}

const ref = (kind: "Product" | "Collection", n: number) => ({ id: `gid://shopify/${kind}/${n}`, title: `${kind} ${n}`, handle: `h${n}` });

// ---------------------------------------------------------------------------
// Phase 4 — placement
// ---------------------------------------------------------------------------

describe("Phase 4: placement", () => {
  const config = () => buildStorefrontConfig(SHOP, [row("d1")], "");

  test("4.1 auto placement: above the add-to-cart buttons, inside the form", () => {
    const p = page(config());
    const slot = p.document.querySelector(".cartlift-slot")!;
    expect(p.document.querySelectorAll(".cl-block")).toHaveLength(1);
    expect(slot.nextElementSibling?.classList.contains("product-form__buttons")).toBe(true);
  });

  test("4.2 embed + app block on one page: one widget, in the block, even with the script loaded twice", () => {
    const body = DAWN_FORM() + `<div class="cartlift-slot" data-product-id="1"></div>`;
    const p = page(config(), { body, blocks: ["auto", "block"], loads: 2 });
    expect(p.document.querySelectorAll(".cl-block")).toHaveLength(1);
    expect(p.document.querySelector('.cartlift-slot[data-product-id="1"] .cl-block')).not.toBeNull();
    // One submit reaches the theme once.
    p.submit();
    expect(p.themeSubmits).toHaveLength(1);
  });

  test.each([
    ["Dawn markup", '<quick-add-modal id="QuickAdd-1" class="quick-add-modal">', "</quick-add-modal>"],
    ["quick-add element without a class", '<quick-add-modal id="QuickAdd-1">', "</quick-add-modal>"],
  ])("4.5 quick add is not hijacked (%s)", (_name, open, close) => {
    const body = `
      ${open}<form action="/cart/add"><input type="hidden" name="id" value="11"><input name="quantity" value="1"><button type="submit">Add</button></form>${close}`;
    const p = page(config(), { body });
    expect(p.document.querySelector(".cl-block")).toBeNull();
    expect((p.document.querySelector('[name="quantity"]') as unknown as HTMLInputElement).value).toBe("1");
    expect(p.document.querySelector('[name="properties[_cartlift]"]')).toBeNull();
  });

  test("4.6 ?cartlift=off loads the page without the widget", () => {
    const p = page(config(), { url: "https://shop.test/products/tee?cartlift=off" });
    expect(p.document.querySelector(".cl-block")).toBeNull();
    expect(p.document.querySelector('[name="properties[_cartlift]"]')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Phase 5 — who sees a deal: widget and checkout must agree
// ---------------------------------------------------------------------------

describe("Phase 5: widget and checkout agree on who gets a deal", () => {
  const cases: { name: string; deal: Json; product: number; collections: number[]; expected: boolean }[] = [
    { name: "ALL", deal: { targetType: "ALL" }, product: 1, collections: [], expected: true },
    { name: "PRODUCTS, in", deal: { targetType: "PRODUCTS", products: [ref("Product", 1)] }, product: 1, collections: [], expected: true },
    { name: "PRODUCTS, out", deal: { targetType: "PRODUCTS", products: [ref("Product", 2)] }, product: 1, collections: [], expected: false },
    { name: "COLLECTIONS, member", deal: { targetType: "COLLECTIONS", collections: [ref("Collection", 7)] }, product: 1, collections: [7], expected: true },
    { name: "COLLECTIONS, not a member", deal: { targetType: "COLLECTIONS", collections: [ref("Collection", 7)] }, product: 1, collections: [8], expected: false },
    { name: "EXCEPT, excluded", deal: { targetType: "EXCEPT", products: [ref("Product", 1)] }, product: 1, collections: [], expected: false },
    { name: "EXCEPT, other product", deal: { targetType: "EXCEPT", products: [ref("Product", 2)] }, product: 1, collections: [], expected: true },
  ];

  test.each(cases)("5.1 targeting $name", ({ deal, product, collections, expected }) => {
    const deals = [row("d1", deal)];
    const shown = page(buildStorefrontConfig(SHOP, deals, ""), { product: { ...TEE, id: product }, collections }).document.querySelector(".cl-block");
    const discounted = checkout(buildFunctionConfig(deals), { productId: product, qty: 2, collections }).length > 0;
    expect(Boolean(shown)).toBe(expected);
    expect(discounted).toBe(expected);
  });

  test("5.2/5.3 only ACTIVE deals inside their schedule are published", () => {
    const now = new Date("2026-09-24T12:00:00Z");
    const hour = 3600_000;
    expect(isLive({ status: "ACTIVE", startsAt: null, endsAt: null }, now)).toBe(true);
    expect(isLive({ status: "DRAFT", startsAt: null, endsAt: null }, now)).toBe(false);
    expect(isLive({ status: "PAUSED", startsAt: null, endsAt: null }, now)).toBe(false);
    expect(isLive({ status: "ACTIVE", startsAt: new Date(+now + hour), endsAt: null }, now)).toBe(false);
    expect(isLive({ status: "ACTIVE", startsAt: null, endsAt: new Date(+now - hour) }, now)).toBe(false);
    expect(isLive({ status: "ACTIVE", startsAt: null, endsAt: now }, now)).toBe(false);
  });

  test("5.2 a published deal whose end has passed disappears from the page before the next republish", () => {
    const ended = row("d1", { endsAt: new Date(Date.now() - 60_000) });
    const future = row("d2", { startsAt: new Date(Date.now() + 86_400_000) });
    expect(page(buildStorefrontConfig(SHOP, [ended], "")).document.querySelector(".cl-block")).toBeNull();
    expect(page(buildStorefrontConfig(SHOP, [future], "")).document.querySelector(".cl-block")).toBeNull();
  });

  test("5.4 priority: the first deal wins on the page, in checkout and in the gift config", () => {
    const deals = [row("first"), row("second")];
    const sf = buildStorefrontConfig(SHOP, deals, "");
    const fn = buildFunctionConfig(deals);
    const gifts = buildGiftConfig(deals);
    expect(sf.deals.map((d) => d.id)).toEqual(["first", "second"]);
    expect(fn.deals.map((d) => d.id)).toEqual(["first", "second"]);
    expect(gifts.deals.map((d) => d.id)).toEqual(["first", "second"]);
    const p = page(sf);
    expect(p.document.querySelector(".cl-block")?.getAttribute("data-deal")).toBe("first");
    expect(checkout(fn, { productId: 1, qty: 2 })[0].message).toContain("first");
    // Reordered: the other deal wins everywhere.
    const reordered = [deals[1], deals[0]];
    expect(page(buildStorefrontConfig(SHOP, reordered, "")).document.querySelector(".cl-block")?.getAttribute("data-deal")).toBe("second");
    expect(checkout(buildFunctionConfig(reordered), { productId: 1, qty: 2 })[0].message).toContain("second");
  });

  test("5.5 markets: outside the market there is no widget and no discount", () => {
    const deals = [row("d1", { config: normalizeConfig({ bars: [newBar({ id: "b", qty: 2, discountType: "percentage", discountValue: 10 })], markets: [{ id: "gid://shopify/Market/1", title: "EU" }] }, "QUANTITY_BREAK") })];
    const countries = new Map([["gid://shopify/Market/1", ["DE", "FR"]]]);
    const sf = buildStorefrontConfig(SHOP, deals, "", countries);
    const fn = buildFunctionConfig(deals, countries);
    expect(page(sf, { country: "DE" }).document.querySelector(".cl-block")).not.toBeNull();
    expect(page(sf, { country: "US" }).document.querySelector(".cl-block")).toBeNull();
    expect(checkout(fn, { productId: 1, qty: 2, country: "DE" })).not.toHaveLength(0);
    expect(checkout(fn, { productId: 1, qty: 2, country: "US" })).toHaveLength(0);
    expect(checkout(fn, { productId: 1, qty: 2, country: null })).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Phase 6 — languages
// ---------------------------------------------------------------------------

describe("Phase 6: languages", () => {
  test("6.5 per-language documents, keyed the way the Liquid snippet looks them up", () => {
    const deal = row("d1", {
      config: normalizeConfig({ bars: [newBar({ id: "b1", qty: 1, title: "One" })], translations: { "pt-BR": { bars: { b1: { title: "Um" } } } } }, "QUANTITY_BREAK"),
    });
    const out = buildTranslations([deal], { de: { each: "/ Stück" } });
    expect([...out.keys()].sort()).toEqual(["de", "pt-BR"]);
    // sync.server.ts publishes `i18n_${locale.replace(/-/g, "_").toLowerCase()}`;
    // cartlift-data.liquid reads 'i18n_' + request.locale.iso_code | downcase | replace: '-', '_'.
    const sync = readFileSync(fileURLToPath(new URL("./sync.server.ts", import.meta.url)), "utf8");
    const liquid = readFileSync(fileURLToPath(new URL("../../extensions/cartlift-widget/snippets/cartlift-data.liquid", import.meta.url)), "utf8");
    expect(sync).toContain('key: `i18n_${locale.replace(/-/g, "_").toLowerCase()}`');
    expect(liquid).toContain("request.locale.iso_code | downcase | replace: '-', '_'");
  });

  test("6.5 a blank translation falls back to the written text; a translated one replaces it", () => {
    const deals = [row("d1", undefined, [newBar({ id: "b1", qty: 1, title: "Single" }), newBar({ id: "b2", qty: 2, title: "Duo", selected: true })])];
    const i18n = { deals: { d1: { bars: { b1: { title: "  " }, b2: { title: "Doppel" } } } } };
    const p = page(buildStorefrontConfig(SHOP, deals, ""), { i18n });
    expect(p.document.querySelector('[data-bar="b1"] .cl-bar-title')?.textContent).toBe("Single");
    expect(p.document.querySelector('[data-bar="b2"] .cl-bar-title')?.textContent).toBe("Doppel");
  });

  test("6.7 every admin text is translated in every language (report)", () => {
    const call = /(?<![A-Za-z0-9_$.])t\("([^"]+)"/g;
    const source = new Set<string>();
    for (const dir of ["../routes", "../components"]) {
      const base = fileURLToPath(new URL(dir, import.meta.url));
      for (const file of readdirSync(base).filter((f) => f.endsWith(".tsx"))) {
        for (const m of readFileSync(`${base}/${file}`, "utf8").matchAll(call)) source.add(m[1]);
      }
    }
    const missing: Record<string, string[]> = {};
    for (const file of readdirSync(fileURLToPath(new URL("../locales", import.meta.url)))) {
      const dict = JSON.parse(readFileSync(fileURLToPath(new URL(`../locales/${file}`, import.meta.url)), "utf8"));
      const gaps = [...source].filter((s) => !(s in dict));
      if (gaps.length) missing[file] = gaps;
    }
    expect(missing).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// 11.2 accessibility, 11.6 failure states
// ---------------------------------------------------------------------------

describe("11.2 keyboard and screen readers", () => {
  const deals = () => [row("d1")];

  test("bars are a radio group, and Enter / Space select a bar", () => {
    const p = page(buildStorefrontConfig(SHOP, deals(), ""));
    const bars = p.document.querySelectorAll('.cl-bar[role="radio"][tabindex="0"]');
    expect(bars).toHaveLength(2);
    expect(p.document.querySelector(".cl-bars")?.getAttribute("role")).toBe("radiogroup");
    const second = p.document.querySelector('[data-bar="d1-2"]') as unknown as HTMLElement;
    second.dispatchEvent(new p.window.KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }) as unknown as Event);
    expect(p.document.querySelector('[data-bar="d1-2"]')?.getAttribute("aria-checked")).toBe("true");
    expect((p.document.querySelector('[name="quantity"]') as unknown as HTMLInputElement).value).toBe("2");
  });

  test("the radio group has an accessible name", () => {
    const p = page(buildStorefrontConfig(SHOP, deals(), ""));
    const group = p.document.querySelector(".cl-bars")!;
    expect(group.getAttribute("aria-label") || group.getAttribute("aria-labelledby")).toBeTruthy();
  });

  test("keyboard focus stays on the bar the shopper just selected", () => {
    const p = page(buildStorefrontConfig(SHOP, deals(), ""));
    const second = p.document.querySelector('[data-bar="d1-2"]') as unknown as HTMLElement;
    second.focus();
    second.dispatchEvent(new p.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }) as unknown as Event);
    expect((p.document.activeElement as unknown as Element | null)?.getAttribute("data-bar")).toBe("d1-2");
  });
});

describe("11.6 the app's domain blocked", () => {
  test("beacons failing never stop the theme's add to cart", () => {
    const p = page(buildStorefrontConfig(SHOP, [row("d1")], "https://cartlift.example"), { beaconThrows: true });
    expect(p.document.querySelector(".cl-block")).not.toBeNull();
    expect(p.submit()).toBe(false);
    expect(p.themeSubmits).toHaveLength(1);
  });

  test("a malformed config never breaks the product form", () => {
    const window = new Window({ url: "https://shop.test/products/tee" });
    window.document.body.innerHTML = DAWN_FORM() + '<script type="application/json" data-cartlift-data="1">{not json</script>';
    expect(() => window.eval(widget)).not.toThrow();
    const broken = page({ v: 1, api: "", css: "", deals: [{ id: "x", tt: "ALL", bars: [{ id: "b" }] }] });
    expect(broken.submit()).toBe(false);
    expect(broken.themeSubmits).toHaveLength(1);
  });
});
