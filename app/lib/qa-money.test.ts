import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import { describe, expect, test } from "vitest";

import { cartLinesDiscountsGenerateRun } from "../../extensions/cartlift-discount/src/cart_lines_discounts_generate_run";
import { planGifts, mergePlan, type AjaxCart, type GiftConfig } from "../../packages/core/src/cart";
import { buildFunctionConfig, buildGiftConfig } from "./sync.server";
import { newBar, normalizeConfig, storefrontDeal, type DealTypeKey } from "./deals";

/**
 * QA pass for docs/TESTING.md Phases 2 and 3, in simulation (pre-submission).
 * Same idea as money-path.test.ts — real widget → real cart lines → real
 * Function → Shopify-style application — but parameterised on prices,
 * currency rate and per-unit variant picks, which that file keeps fixed.
 */

const asset = readFileSync(
  fileURLToPath(new URL("../../extensions/cartlift-widget/assets/cartlift.js", import.meta.url)),
  "utf8",
);

type Variant = { id: number; title: string; options?: string[]; price: number; compare_at_price: number | null; available: boolean };
type Product = { id: number; title: string; handle: string; options?: string[]; variants: Variant[] };
interface PostedLine {
  id: number;
  quantity: number;
  properties?: Record<string, string>;
}

const productWith = (...prices: number[]): Product => ({
  id: 1,
  title: "Tee",
  handle: "tee",
  options: ["Size"],
  variants: prices.map((price, i) => ({
    id: 11 + i,
    title: `V${i}`,
    options: [`V${i}`],
    price,
    compare_at_price: null,
    available: true,
  })),
});

interface ShopOptions {
  product: Product;
  rate?: number;
  pickBar?: string;
  /** Per-unit option picks: [unit, optionIndex, value]. */
  picks?: [number, number, string][];
}

function shopper(deal: unknown, o: ShopOptions) {
  const window = new Window({ url: "https://shop.test/products/tee" });
  const document = window.document;
  const posted: { items: PostedLine[] }[] = [];
  Object.assign(window, {
    fetch: async (url: string, init: { body: string }) => {
      if (String(url).includes("cart/add.js")) posted.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ items: [] }) };
    },
    Shopify: { currency: { rate: String(o.rate ?? 1) }, routes: { root: "/" } },
    alert: () => {},
  });
  (window.navigator as unknown as { sendBeacon: () => boolean }).sendBeacon = () => true;
  document.body.innerHTML = `
    <section class="shopify-section">
      <form action="/cart/add" class="product-form">
        <input type="hidden" name="id" value="${o.product.variants[0].id}">
        <div class="product-form__quantity"><input name="quantity" value="1"></div>
        <div class="product-form__buttons"><button type="submit" name="add">Add</button><div class="shopify-payment-button"></div></div>
      </form>
    </section>`;
  const data = document.createElement("script");
  data.type = "application/json";
  data.setAttribute("data-cartlift-data", "1");
  data.textContent = JSON.stringify({
    config: { v: 1, api: "", css: "", deals: [deal] },
    product: o.product,
    collections: [],
    moneyFormat: "${{amount}}",
    shop: "s.myshopify.com",
    placement: "auto",
  });
  document.body.appendChild(data);
  window.eval(asset);

  const el = (selector: string) => document.querySelector(selector) as unknown as HTMLElement;
  if (o.pickBar) el(`[data-bar="${o.pickBar}"]`).dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event);
  for (const [unit, opt, value] of o.picks ?? []) {
    const select = el(`select[data-unit="${unit}"][data-opt="${opt}"]`) as unknown as HTMLSelectElement;
    select.value = value;
    select.dispatchEvent(new window.Event("change", { bubbles: true }) as unknown as Event);
  }
  const shown = document.querySelector(".cl-bar.is-selected .cl-price")?.textContent ?? "";
  const buyNowHidden = Boolean(document.querySelector(".shopify-payment-button.cartlift-hidden"));
  el("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event);

  let lines = posted[0]?.items;
  if (!lines) {
    const properties: Record<string, string> = {};
    for (const input of Array.from(document.querySelectorAll('form input[type="hidden"]'))) {
      const name = (input as unknown as { name: string }).name;
      const match = name.match(/^properties\[(.+)\]$/);
      if (match) properties[match[1]] = (input as unknown as { value: string }).value;
    }
    lines = [
      {
        id: Number((document.querySelector('[name="id"]') as unknown as { value: string }).value),
        quantity: Number((document.querySelector('[name="quantity"]') as unknown as { value: string }).value),
        properties,
      },
    ];
  }
  return { shownCents: Math.round(Number(shown.replace(/[^0-9.]/g, "")) * 100), lines, buyNowHidden };
}

function asFunctionInput(lines: PostedLine[], prices: Map<number, number>, config: ReturnType<typeof buildFunctionConfig>, rate: number) {
  return {
    presentmentCurrencyRate: String(rate),
    localization: { country: { isoCode: "US" } },
    cart: {
      lines: lines.map((line, i) => ({
        id: `gid://shopify/CartLine/${i + 1}`,
        quantity: line.quantity,
        cost: { amountPerQuantity: { amount: String((prices.get(line.id) ?? 0) / 100) } },
        deal: line.properties?._cartlift ? { value: line.properties._cartlift } : null,
        arm: line.properties?._cartlift_arm ? { value: line.properties._cartlift_arm } : null,
        bar: line.properties?._cartlift_bar ? { value: line.properties._cartlift_bar } : null,
        gift: line.properties?._cartlift_gift ? { value: line.properties._cartlift_gift } : null,
        upsell: line.properties?._cartlift_upsell ? { value: line.properties._cartlift_upsell } : null,
        bundle: line.properties?._cartlift_bundle ? { value: line.properties._cartlift_bundle } : null,
        sellingPlanAllocation: null,
        merchandise: {
          __typename: "ProductVariant",
          id: `gid://shopify/ProductVariant/${line.id}`,
          product: { id: "gid://shopify/Product/1", inCollections: [], complementary: null },
        },
      })),
    },
    discount: { discountClasses: ["PRODUCT"], metafield: { jsonValue: config } },
  } as never;
}

/**
 * Applies candidates like Shopify: percentage per target (rounded to the cent),
 * fixedAmount per item when `appliesToEachItem`, otherwise the amount once,
 * spread over the targets and capped at what they cost.
 */
function charge(lines: PostedLine[], prices: Map<number, number>, result: ReturnType<typeof cartLinesDiscountsGenerateRun>) {
  const lineTotal = (i: number, qty?: number) => (prices.get(lines[i].id) ?? 0) * (qty ?? lines[i].quantity);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const candidates = ((result.operations[0] as any)?.productDiscountsAdd?.candidates ?? []) as any[];
  let off = 0;
  let giftOff = 0;
  for (const c of candidates) {
    const targets = c.targets.map((t: { cartLine: { id: string; quantity?: number } }) => ({
      i: Number(t.cartLine.id.split("/").pop()) - 1,
      qty: t.cartLine.quantity,
    }));
    const base = targets.reduce((s: number, t: { i: number; qty?: number }) => s + lineTotal(t.i, t.qty), 0);
    let amount = 0;
    if (c.value.percentage) {
      amount = targets.reduce(
        (s: number, t: { i: number; qty?: number }) => s + Math.round((lineTotal(t.i, t.qty) * c.value.percentage.value) / 100),
        0,
      );
    } else if (c.value.fixedAmount?.appliesToEachItem) {
      amount = targets.reduce(
        (s: number, t: { i: number; qty?: number }) =>
          s + Math.min(lineTotal(t.i, t.qty), Math.round(c.value.fixedAmount.amount * 100) * (t.qty ?? lines[t.i].quantity)),
        0,
      );
    } else {
      amount = Math.round(c.value.fixedAmount.amount * 100);
    }
    amount = Math.min(amount, base);
    if (targets.every((t: { i: number }) => lines[t.i].properties?._cartlift_gift)) giftOff += amount;
    else off += amount;
  }
  let full = 0;
  let giftFull = 0;
  lines.forEach((line, i) => {
    if (line.properties?._cartlift_gift) giftFull += lineTotal(i);
    else full += lineTotal(i);
  });
  return { paid: full - off, giftPaid: giftFull - giftOff };
}

function buy(config: unknown, o: ShopOptions & { type?: DealTypeKey }) {
  const type = o.type ?? "QUANTITY_BREAK";
  const deal = {
    id: "d1",
    name: "Deal",
    type,
    targetType: "ALL" as const,
    products: [],
    collections: [],
    startsAt: null,
    endsAt: null,
    config: normalizeConfig(config, type),
  };
  const prices = new Map(o.product.variants.map((v) => [v.id, v.price]));
  prices.set(91, 500);
  const rate = o.rate ?? 1;
  const { shownCents, lines, buyNowHidden } = shopper(storefrontDeal(deal), o);
  const fnConfig = buildFunctionConfig([deal as never]);
  const { paid, giftPaid } = charge(lines, prices, cartLinesDiscountsGenerateRun(asFunctionInput(lines, prices, fnConfig, rate)));
  return { shownCents, paid, giftPaid, lines, buyNowHidden };
}

// ---------------------------------------------------------------------------
// 2.1 / 2.6 — odd prices and quantities
// ---------------------------------------------------------------------------

describe("2.1/2.6 odd prices: shown = charged", () => {
  const cases: [number, number, "percentage" | "amount" | "fixed_total", number][] = [
    [1999, 3, "percentage", 20],
    [3333, 7, "percentage", 15],
    [1999, 3, "fixed_total", 50],
    [3333, 7, "fixed_total", 199.99],
    [1999, 3, "amount", 2.5],
    [3333, 7, "amount", 3.33],
    [999, 3, "percentage", 33],
  ];
  for (const [price, qty, dt, dv] of cases) {
    test(`${qty} × ${price / 100} with ${dt} ${dv}`, () => {
      const r = buy({ bars: [newBar({ id: "b1", qty: 1 }), newBar({ id: "t", qty, discountType: dt, discountValue: dv, selected: true })] }, {
        product: productWith(price),
      });
      expect(r.paid).toBe(r.shownCents);
    });
  }

  test("fixed total higher than the full price: nothing charged beyond full price", () => {
    const r = buy({ bars: [newBar({ id: "b1", qty: 1 }), newBar({ id: "t", qty: 3, discountType: "fixed_total", discountValue: 100, selected: true })] }, {
      product: productWith(2000),
    });
    expect(r.shownCents).toBe(6000);
    expect(r.paid).toBe(6000);
  });
});

// ---------------------------------------------------------------------------
// 2.12 — presentment currency
// ---------------------------------------------------------------------------

describe("2.12 currency rate: shop-currency amounts convert the same on both sides", () => {
  // Product prices here are already in presentment currency (Liquid gives them converted).
  for (const rate of [0.92, 1.3456, 83.1]) {
    for (const [dt, dv] of [["fixed_total", 50], ["amount", 5], ["percentage", 10]] as const) {
      test(`rate ${rate}, ${dt} ${dv}`, () => {
        const price = Math.round(2000 * rate);
        const r = buy({ bars: [newBar({ id: "b1", qty: 1 }), newBar({ id: "t", qty: 3, discountType: dt, discountValue: dv, selected: true })] }, {
          product: productWith(price),
          rate,
        });
        expect(r.paid).toBe(r.shownCents);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// 2.2 — BXGY with cheapest-unit and extra %
// ---------------------------------------------------------------------------

describe("2.2 buy X get Y, odd prices and extra %", () => {
  test("buy 2 get 1 free at 19.99", () => {
    const r = buy({ bars: [newBar({ id: "x", kind: "bxgy", qty: 3, get: 1, discountType: "percentage", discountValue: 100, selected: true })] }, {
      product: productWith(1999),
      type: "BXGY",
    });
    expect(r.shownCents).toBe(3998);
    expect(r.paid).toBe(r.shownCents);
  });

  test("buy 3 get 1 + 10% at 33.33", () => {
    const r = buy(
      { bars: [newBar({ id: "x", kind: "bxgy", qty: 4, get: 1, discountType: "percentage", discountValue: 100, extraPercent: 10, selected: true })] },
      { product: productWith(3333), type: "BXGY" },
    );
    expect(r.paid).toBe(r.shownCents);
  });

  test("BXGY Y at a fixed price, rate 0.92", () => {
    const r = buy({ bars: [newBar({ id: "x", kind: "bxgy", qty: 2, get: 1, discountType: "fixed_total", discountValue: 5, selected: true })] }, {
      product: productWith(1840),
      rate: 0.92,
      type: "BXGY",
    });
    expect(r.paid).toBe(r.shownCents);
  });
});

// ---------------------------------------------------------------------------
// 2.9 — variant per unit, variants at DIFFERENT prices
// ---------------------------------------------------------------------------

describe("2.9 variant per unit with different variant prices", () => {
  const product = productWith(2000, 2500);

  test("percentage bar: the price shown is what checkout charges", () => {
    const r = buy(
      { variantPerUnit: true, bars: [newBar({ id: "b1", qty: 1 }), newBar({ id: "t", qty: 2, discountType: "percentage", discountValue: 10, selected: true })] },
      { product, picks: [[1, 0, "V1"]] },
    );
    expect(r.lines.map((l) => [l.id, l.quantity])).toEqual([
      [11, 1],
      [12, 1],
    ]);
    // Checkout: (20 + 25) × 0.9 = 40.50.
    expect(r.paid).toBe(4050);
    expect(r.shownCents).toBe(r.paid);
  });

  test("buy 1 get 1 free: the cheaper unit is free at checkout, the widget should say so", () => {
    const r = buy(
      { variantPerUnit: true, bars: [newBar({ id: "x", kind: "bxgy", qty: 2, get: 1, discountType: "percentage", discountValue: 100, selected: true })] },
      { product, picks: [[1, 0, "V1"]], type: "BXGY" },
    );
    expect(r.paid).toBe(2500);
    expect(r.shownCents).toBe(r.paid);
  });

  test("fixed total over several lines: exactly the total", () => {
    const r = buy(
      { variantPerUnit: true, bars: [newBar({ id: "b1", qty: 1 }), newBar({ id: "t", qty: 2, discountType: "fixed_total", discountValue: 40, selected: true })] },
      { product, picks: [[1, 0, "V1"]] },
    );
    expect(r.lines).toHaveLength(2);
    expect(r.paid).toBe(4000);
    expect(r.shownCents).toBe(4000);
  });
});

// ---------------------------------------------------------------------------
// 2.11 — buy-it-now
// ---------------------------------------------------------------------------

describe("2.11 buy-it-now", () => {
  test("hidden for a multi-line offer (gift), shown for a single line", () => {
    const gift = [{ id: "gid://shopify/ProductVariant/91", title: "Socks", productId: "gid://shopify/Product/9" }];
    const multi = buy({ bars: [newBar({ id: "g", qty: 2, discountType: "percentage", discountValue: 10, selected: true, gifts: gift })] }, {
      product: productWith(2000),
    });
    expect(multi.lines.length).toBeGreaterThan(1);
    expect(multi.buyNowHidden).toBe(true);
    expect(multi.giftPaid).toBe(0);

    const single = buy({ bars: [newBar({ id: "b", qty: 2, discountType: "percentage", discountValue: 10, selected: true })] }, {
      product: productWith(2000),
    });
    expect(single.lines).toHaveLength(1);
    expect(single.buyNowHidden).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Phase 3 — cart watcher plans (core planGifts / mergePlan)
// ---------------------------------------------------------------------------

describe("Phase 3: gift planning across two deals and cart edits", () => {
  const dealRow = (id: string, productGid: string, giftGid: string, priority: number) => ({
    id,
    name: id,
    type: "QUANTITY_BREAK",
    status: "ACTIVE",
    priority,
    targetType: "PRODUCTS",
    products: [{ id: productGid, title: id }],
    collections: [],
    startsAt: null,
    endsAt: null,
    config: normalizeConfig(
      {
        bars: [
          newBar({ id: `${id}1`, qty: 1 }),
          newBar({ id: `${id}2`, qty: 2, discountType: "percentage", discountValue: 10, gifts: [{ id: giftGid, title: "G", productId: "gid://shopify/Product/99" }] }),
        ],
      },
      "QUANTITY_BREAK",
    ),
  });
  const config = buildGiftConfig([
    dealRow("dA", "gid://shopify/Product/1", "gid://shopify/ProductVariant/91", 0),
    dealRow("dB", "gid://shopify/Product/2", "gid://shopify/ProductVariant/92", 1),
  ] as never) as unknown as GiftConfig;
  const line = (key: string, product: number, variant: number, quantity: number, properties: Record<string, string> = {}) => ({
    key,
    product_id: product,
    variant_id: variant,
    quantity,
    properties,
  });

  test("3.2/3.5: both tiers reached from the cart page → each gift added exactly once", () => {
    const cart = { token: "t", items: [line("a", 1, 11, 2), line("b", 2, 21, 3)] } as unknown as AjaxCart;
    const plan = planGifts(config, cart, {})!;
    expect(plan.adds.map((a) => a.id).sort()).toEqual([91, 92]);
    // Apply the adds and re-plan: stable, nothing more to do (no loop).
    const next = {
      token: "t",
      items: [...cart.items, line("g1", 99, 91, 1, { _cartlift_gift: "dA" }), line("g2", 99, 92, 1, { _cartlift_gift: "dB" })],
    } as unknown as AjaxCart;
    const again = planGifts(config, next, {})!;
    expect(again.adds).toEqual([]);
    expect(again.updates).toEqual({});
  });

  test("3.3: dropping below the tier removes only that deal's gift", () => {
    const cart = {
      token: "t",
      items: [
        line("a", 1, 11, 1),
        line("b", 2, 21, 2),
        line("g1", 99, 91, 1, { _cartlift_gift: "dA" }),
        line("g2", 99, 92, 1, { _cartlift_gift: "dB" }),
      ],
    } as unknown as AjaxCart;
    const plan = planGifts(config, cart, {})!;
    expect(plan.updates).toEqual({ g1: 0 });
    expect(plan.adds).toEqual([]);
  });

  test("a gift line whose quantity the shopper raised is trimmed back to one", () => {
    const cart = { token: "t", items: [line("a", 1, 11, 2), line("g1", 99, 91, 4, { _cartlift_gift: "dA" })] } as unknown as AjaxCart;
    expect(planGifts(config, cart, {})!.updates).toEqual({ g1: 1 });
  });

  test("a forged gift tag for a deal that doesn't exist is removed", () => {
    const cart = { token: "t", items: [line("a", 1, 11, 2), line("x", 99, 91, 1, { _cartlift_gift: "nope" })] } as unknown as AjaxCart;
    expect(planGifts(config, cart, {})!.updates).toEqual({ x: 0 });
  });

  test("merge: plain line of the same variant moves onto the tagged line", () => {
    const cart = { token: "t", items: [line("a", 1, 11, 2, { _cartlift: "dA" }), line("p", 1, 11, 1)] } as unknown as AjaxCart;
    const merged = mergePlan(cart);
    expect(merged).toEqual({ a: 3, p: 0 });
  });
});
