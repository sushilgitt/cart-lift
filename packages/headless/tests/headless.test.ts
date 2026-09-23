import { describe, expect, test } from "vitest";

import { barPrice, dealFor, initialBar, linesFor, plansFor, type CartLiftConfig, type CartLiftDeal } from "../src";

/**
 * A headless storefront builds its own cart, so the only thing keeping it in
 * step with checkout is the line attributes. These tests pin that contract, and
 * that the prices shown match the shared pricing rules.
 */

const bar = (o: Partial<CartLiftDeal["bars"][number]> = {}) => ({
  id: "b1",
  kind: "qty" as const,
  qty: 1,
  get: 0,
  dt: "none" as const,
  dv: 0,
  title: "One",
  subtitle: "",
  badge: "",
  selected: false,
  ...o,
});

const deal = (o: Partial<CartLiftDeal> = {}): CartLiftDeal => ({
  id: "d1",
  name: "Bundle & save",
  tt: "ALL",
  p: [],
  c: [],
  s: null,
  e: null,
  bars: [bar({ id: "b1" }), bar({ id: "b2", qty: 2, dt: "percentage", dv: 10, selected: true })],
  ...o,
});

const config = (deals: CartLiftDeal[]): CartLiftConfig => ({ v: 1, deals });

describe("picking a deal", () => {
  test("targeting, schedule and market all have to match", () => {
    const only7 = deal({ id: "only7", tt: "PRODUCTS", p: [7] });
    const everywhere = deal({ id: "all" });
    expect(dealFor(config([only7, everywhere]), { id: 7 })?.id).toBe("only7");
    expect(dealFor(config([only7, everywhere]), { id: 8 })?.id).toBe("all");

    const collection = deal({ id: "col", tt: "COLLECTIONS", c: [42] });
    expect(dealFor(config([collection]), { id: 8, collectionIds: [42] })?.id).toBe("col");
    expect(dealFor(config([collection]), { id: 8, collectionIds: [1] })).toBe(null);

    const future = deal({ id: "later", s: "2030-01-01T00:00:00.000Z" });
    expect(dealFor(config([future]), { id: 1 })).toBe(null);
    const past = deal({ id: "over", e: "2020-01-01T00:00:00.000Z" });
    expect(dealFor(config([past]), { id: 1 })).toBe(null);

    const german = deal({ id: "de", ctry: ["DE"] });
    expect(dealFor(config([german]), { id: 1 }, { country: "DE" })?.id).toBe("de");
    expect(dealFor(config([german]), { id: 1 }, { country: "US" })).toBe(null);
    // No country known at all: a deal limited to markets stays out.
    expect(dealFor(config([german]), { id: 1 })).toBe(null);
  });

  test("the bar marked selected is the one the page opens on", () => {
    expect(initialBar(deal())?.id).toBe("b2");
    expect(initialBar(deal({ bars: [bar({ id: "x" }), bar({ id: "y" })] }))?.id).toBe("x");
  });
});

describe("what a bar costs", () => {
  test("the same arithmetic the widget and checkout use", () => {
    const tenPercentOffTwo = bar({ qty: 2, dt: "percentage", dv: 10 });
    expect(barPrice(tenPercentOffTwo, 2000)).toMatchObject({ total: 3600, full: 4000, saved: 400, savedPct: 10, unit: 1800 });

    const fixedTotal = bar({ qty: 3, dt: "fixed_total", dv: 50 });
    expect(barPrice(fixedTotal, 2000).total).toBe(5000);

    const bogo = bar({ kind: "bxgy", qty: 2, get: 1, dt: "percentage", dv: 100 });
    expect(barPrice(bogo, 2000).total).toBe(2000);
  });

  test("a bundle bar prices each item on its own", () => {
    const bundle = bar({
      kind: "bundle",
      items: [
        { v: null, q: 1, dt: "none" as const, dv: 0 },
        { v: 99, q: 2, dt: "percentage" as const, dv: 50, price: "1000" },
      ],
    });
    // $20 + 2 × $10 at half price
    expect(barPrice(bundle, 2000)).toMatchObject({ total: 3000, full: 4000, unit: 1000 });
  });
});

describe("the cart lines checkout has to recognise", () => {
  test("a plain tier: one line, tagged with the deal and the arm", () => {
    const d = deal();
    expect(linesFor(d, d.bars[1], { variantId: 11 })).toEqual([
      {
        merchandiseId: "gid://shopify/ProductVariant/11",
        quantity: 2,
        attributes: [
          { key: "_cartlift", value: "d1" },
          { key: "_cartlift_arm", value: "A" },
        ],
      },
    ]);
  });

  test("two bars of the same size: the bar is named, or checkout can't tell them apart", () => {
    const d = deal({ bars: [bar({ id: "plain", qty: 2 }), bar({ id: "gifted", qty: 2 })] });
    const attributes = linesFor(d, d.bars[1], { variantId: 11 })[0].attributes;
    expect(attributes).toContainEqual({ key: "_cartlift_bar", value: "gifted" });
  });

  test("a variant per unit becomes one line per variant", () => {
    const d = deal({ bars: [bar({ id: "b3", qty: 3 })] });
    const lines = linesFor(d, d.bars[0], { variantId: 11, variantIds: [11, 12, 12] });
    expect(lines.map((l) => [l.merchandiseId, l.quantity])).toEqual([
      ["gid://shopify/ProductVariant/11", 1],
      ["gid://shopify/ProductVariant/12", 2],
    ]);
  });

  test("gifts ride along as one-time lines, even when the shopper subscribed", () => {
    const d = deal({ bars: [bar({ id: "g", qty: 2, gifts: [{ id: 91, title: "Socks" }] })] });
    const lines = linesFor(d, d.bars[0], { variantId: 11, sellingPlanId: 501 });
    expect(lines[0].sellingPlanId).toBe("gid://shopify/SellingPlan/501");
    expect(lines[1]).toEqual({
      merchandiseId: "gid://shopify/ProductVariant/91",
      quantity: 1,
      attributes: [{ key: "_cartlift_gift", value: "d1" }],
    });
    expect(lines[1].sellingPlanId).toBeUndefined();
  });

  test("a bundle tags every item, and marks the product being viewed", () => {
    const d = deal({
      bars: [
        bar({
          id: "set",
          kind: "bundle",
          items: [
            { v: null, q: 1, dt: "none" as const, dv: 0 },
            { v: 99, q: 2, dt: "percentage" as const, dv: 50 },
          ],
        }),
      ],
    });
    const lines = linesFor(d, d.bars[0], { variantId: 11, arm: "B" });
    expect(lines[0].attributes).toEqual([
      { key: "_cartlift_bundle", value: "d1:set" },
      { key: "_cartlift_arm", value: "B" },
      { key: "_cartlift_main", value: "1" },
    ]);
    expect(lines[1]).toMatchObject({ merchandiseId: "gid://shopify/ProductVariant/99", quantity: 2 });
  });

  test("ids that already are gids are left alone", () => {
    const d = deal();
    const line = linesFor(d, d.bars[0], { variantId: "gid://shopify/ProductVariant/77" })[0];
    expect(line.merchandiseId).toBe("gid://shopify/ProductVariant/77");
  });
});

describe("subscriptions", () => {
  const allocations = [
    { sellingPlan: { id: "gid://shopify/SellingPlan/501", name: "Every 2 weeks" }, price: { amount: "18.00" } },
  ];

  test("plans are offered only when the deal asks for them", () => {
    expect(plansFor(deal(), allocations)).toEqual([]);
    const subscribable = deal({ sub: { on: true, apply: "b", one: "One-time", sub: "Subscribe", pre: "one" } });
    expect(plansFor(subscribable, allocations)).toEqual([
      { id: "gid://shopify/SellingPlan/501", name: "Every 2 weeks", price: 1800 },
    ]);
  });
});
