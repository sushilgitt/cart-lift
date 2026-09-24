import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import { describe, expect, test } from "vitest";

import { cartLinesDiscountsGenerateRun } from "../../extensions/cartlift-discount/src/cart_lines_discounts_generate_run";
import { buildFunctionConfig } from "./sync.server";
import { newBar, normalizeConfig, storefrontDeal, type DealTypeKey } from "./deals";

/**
 * The one thing that must never be wrong: the price a shopper is **shown** is
 * the price checkout **charges**.
 *
 * Every other test here checks one side of that — the widget's arithmetic, or
 * the Function's. This one joins them: it runs the real built widget in a DOM,
 * takes the exact cart lines it posts, feeds those to the real Discount
 * Function, applies the discounts the way Shopify does, and compares the total
 * with what the widget printed on the bar.
 *
 * It can't see themes, taxes or Shopify's own discount stacking — only a real
 * order can (docs/TESTING.md, Phase 2). What it does catch is the two sides
 * drifting apart, which is the expensive kind of bug.
 */

const asset = readFileSync(
  fileURLToPath(new URL("../../extensions/cartlift-widget/assets/cartlift.js", import.meta.url)),
  "utf8",
);

/** The fixture catalogue, in cents. */
const PRICES: Record<number, number> = { 11: 2000, 12: 2000, 13: 2500, 91: 500, 77: 1000 };

const PRODUCT = {
  id: 1,
  title: "Tee",
  handle: "tee",
  variants: [
    { id: 11, title: "S", price: 2000, compare_at_price: 2500, available: true },
    { id: 12, title: "M", price: 2000, compare_at_price: 2500, available: true },
    { id: 13, title: "L", price: 2500, compare_at_price: null, available: true },
  ],
};

interface PostedLine {
  id: number;
  quantity: number;
  properties?: Record<string, string>;
}

/** Runs the widget on a product page: what it showed, and what it adds to the cart. */
function shopper(deal: unknown, pickBar?: string) {
  const window = new Window({ url: "https://shop.test/products/tee" });
  const document = window.document;
  const posted: { items: PostedLine[] }[] = [];
  Object.assign(window, {
    fetch: async (url: string, init: { body: string }) => {
      if (String(url).includes("cart/add.js")) posted.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ items: [] }) };
    },
    Shopify: { currency: { rate: "1.0" }, routes: { root: "/" } },
    alert: () => {},
  });
  (window.navigator as unknown as { sendBeacon: () => boolean }).sendBeacon = () => true;
  document.body.innerHTML = `
    <section class="shopify-section">
      <form action="/cart/add" class="product-form">
        <input type="hidden" name="id" value="11">
        <div class="product-form__quantity"><input name="quantity" value="1"></div>
        <div class="product-form__buttons"><button type="submit" name="add">Add</button><div class="shopify-payment-button"></div></div>
      </form>
    </section>`;
  const data = document.createElement("script");
  data.type = "application/json";
  data.setAttribute("data-cartlift-data", "1");
  data.textContent = JSON.stringify({
    config: { v: 1, api: "", css: "", deals: [deal] },
    product: PRODUCT,
    collections: [],
    moneyFormat: "${{amount}}",
    shop: "s.myshopify.com",
    placement: "auto",
  });
  document.body.appendChild(data);
  window.eval(asset);

  // happy-dom's own Element/Event types differ from the DOM lib's; the widget
  // only cares that a real event arrives.
  const el = (selector: string) => document.querySelector(selector) as unknown as HTMLElement;
  if (pickBar) {
    el(`[data-bar="${pickBar}"]`).dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event);
  }
  const shown = document.querySelector(".cl-bar.is-selected .cl-price")?.textContent ?? "";
  el("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event);

  // A single-line offer goes through the theme's own form, not /cart/add.js.
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
  return { shownCents: Math.round(Number(shown.replace(/[^0-9.]/g, "")) * 100), lines };
}

/** Those cart lines, as the Discount Function sees them. */
function asFunctionInput(lines: PostedLine[], config: ReturnType<typeof buildFunctionConfig>) {
  return {
    presentmentCurrencyRate: "1.0",
    localization: { country: { isoCode: "US" } },
    cart: {
      lines: lines.map((line, i) => ({
        id: `gid://shopify/CartLine/${i + 1}`,
        quantity: line.quantity,
        cost: { amountPerQuantity: { amount: String((PRICES[line.id] ?? 0) / 100) } },
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
          product: {
            id: "gid://shopify/Product/1",
            inCollections: (config.collectionIds ?? []).map((c) => ({ collectionId: c, isMember: false })),
            complementary: null,
          },
        },
      })),
    },
    discount: { discountClasses: ["PRODUCT"], metafield: { jsonValue: config } },
  } as never;
}

/**
 * Applies the candidates the way Shopify does (selection strategy ALL), keeping
 * the deal's own lines and its gift lines apart. Gifts are priced in the *same*
 * run as the deal, because that run is what makes them free.
 */
function charge(lines: PostedLine[], result: ReturnType<typeof cartLinesDiscountsGenerateRun>) {
  const off = new Map(lines.map((_, i) => [`gid://shopify/CartLine/${i + 1}`, 0]));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const candidates = ((result.operations[0] as any)?.productDiscountsAdd?.candidates ?? []) as any[];
  for (const candidate of candidates) {
    for (const target of candidate.targets) {
      const key = target.cartLine.id as string;
      const index = Number(key.split("/").pop()) - 1;
      const line = lines[index];
      if (!line) continue;
      const unit = PRICES[line.id] ?? 0;
      const quantity = target.cartLine.quantity ?? line.quantity;
      if (candidate.value.percentage) {
        off.set(key, (off.get(key) ?? 0) + Math.round(unit * quantity * (candidate.value.percentage.value / 100)));
      } else if (candidate.value.fixedAmount) {
        const amount = Math.round(candidate.value.fixedAmount.amount * 100);
        off.set(key, (off.get(key) ?? 0) + (candidate.value.fixedAmount.appliesToEachItem ? amount * quantity : amount));
      }
    }
  }

  let paid = 0;
  let giftPaid = 0;
  lines.forEach((line, i) => {
    const before = (PRICES[line.id] ?? 0) * line.quantity;
    const after = Math.max(0, before - (off.get(`gid://shopify/CartLine/${i + 1}`) ?? 0));
    if (line.properties?._cartlift_gift) giftPaid += after;
    else paid += after;
  });
  return { paid, giftPaid };
}

/** Builds a deal the way the admin would, then walks it through the whole path. */
function buy(config: unknown, options: { type?: DealTypeKey; pickBar?: string } = {}) {
  const type = options.type ?? "QUANTITY_BREAK";
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
  const { shownCents, lines } = shopper(storefrontDeal(deal), options.pickBar);
  const fnConfig = buildFunctionConfig([deal as never]);
  const { paid, giftPaid } = charge(lines, cartLinesDiscountsGenerateRun(asFunctionInput(lines, fnConfig)));
  return { shownCents, paid, giftPaid, lines };
}

const tiers = (...bars: ReturnType<typeof newBar>[]) => ({ bars });

describe("what the shopper is shown is what checkout charges", () => {
  test("quantity breaks, on the preselected tier and on a chosen one", () => {
    const two = buy(
      tiers(newBar({ id: "b1", qty: 1 }), newBar({ id: "b2", qty: 2, discountType: "percentage", discountValue: 10, selected: true })),
    );
    expect(two.shownCents).toBe(3600);
    expect(two.paid).toBe(two.shownCents);

    const three = buy(
      tiers(
        newBar({ id: "b1", qty: 1 }),
        newBar({ id: "b2", qty: 2, discountType: "percentage", discountValue: 10 }),
        newBar({ id: "b3", qty: 3, discountType: "percentage", discountValue: 20 }),
      ),
      { pickBar: "b3" },
    );
    expect(three.shownCents).toBe(4800);
    expect(three.paid).toBe(three.shownCents);
  });

  test("buy X get Y: the free units really are free", () => {
    const bogo = buy(tiers(newBar({ id: "x", kind: "bxgy", qty: 2, get: 1, discountType: "percentage", discountValue: 100, selected: true })), {
      type: "BXGY",
    });
    expect(bogo.shownCents).toBe(2000);
    expect(bogo.paid).toBe(bogo.shownCents);

    const half = buy(tiers(newBar({ id: "x", kind: "bxgy", qty: 5, get: 2, discountType: "percentage", discountValue: 50, selected: true })), {
      type: "BXGY",
    });
    expect(half.shownCents).toBe(8000);
    expect(half.paid).toBe(half.shownCents);
  });

  test("a fixed total charges exactly that", () => {
    const fixed = buy(tiers(newBar({ id: "b1", qty: 1 }), newBar({ id: "f", qty: 3, discountType: "fixed_total", discountValue: 50, selected: true })));
    expect(fixed.shownCents).toBe(5000);
    expect(fixed.paid).toBe(5000);
  });

  test("an amount off each item", () => {
    const amount = buy(tiers(newBar({ id: "b1", qty: 1 }), newBar({ id: "a", qty: 2, discountType: "amount", discountValue: 5, selected: true })));
    expect(amount.shownCents).toBe(3000);
    expect(amount.paid).toBe(amount.shownCents);
  });

  test("two bars of the same size: checkout prices the one that was picked", () => {
    const picked = buy(
      tiers(
        newBar({ id: "plain", qty: 2, discountType: "percentage", discountValue: 10 }),
        newBar({ id: "better", qty: 2, discountType: "percentage", discountValue: 25 }),
      ),
      { pickBar: "better" },
    );
    expect(picked.shownCents).toBe(3000);
    expect(picked.paid).toBe(picked.shownCents);
  });

  test("a free gift costs the shopper nothing, and doesn't change the bar's price", () => {
    const gifted = buy(
      tiers(
        newBar({ id: "b1", qty: 1 }),
        newBar({
          id: "g",
          qty: 2,
          discountType: "percentage",
          discountValue: 10,
          selected: true,
          gifts: [{ id: "gid://shopify/ProductVariant/91", title: "Socks", productId: "gid://shopify/Product/9" }],
        }),
      ),
    );
    expect(gifted.shownCents).toBe(3600);
    expect(gifted.paid).toBe(3600);
    expect(gifted.giftPaid).toBe(0);
    expect(gifted.lines).toHaveLength(2);
  });

  test("compare-at pricing changes what's struck through, not what's charged", () => {
    const compare = buy({
      style: { useCompareAt: true },
      bars: [newBar({ id: "b1", qty: 1 }), newBar({ id: "b2", qty: 2, discountType: "percentage", discountValue: 10, selected: true })],
    });
    expect(compare.shownCents).toBe(3600);
    expect(compare.paid).toBe(compare.shownCents);
  });
});
