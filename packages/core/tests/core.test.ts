import { describe, expect, test } from "vitest";
import {
  bundleSets,
  dealMatches,
  escapeHtml,
  formatMoney,
  matchesTarget,
  mergePlan,
  moneyToCents,
  planGifts,
  priceBar,
  priceBundle,
  priceMixed,
  reachedBar,
  renderText,
  type AjaxCart,
  type GiftConfig,
} from "../src";

describe("priceBar", () => {
  const unit = 2000; // $20.00

  test("percentage off each item", () => {
    expect(priceBar({ kind: "qty", qty: 3, dt: "percentage", dv: 20 }, unit)).toEqual({
      total: 4800,
      full: 6000,
      saved: 1200,
      savedPct: 20,
      unit: 1600,
    });
  });

  test("amount off each item converts with the rate and never goes below zero", () => {
    expect(priceBar({ kind: "qty", qty: 2, dt: "amount", dv: 3 }, unit, 0, 2).total).toBe(2800);
    expect(priceBar({ kind: "qty", qty: 2, dt: "amount", dv: 50 }, unit).total).toBe(0);
  });

  test("fixed total price, capped at the full price", () => {
    expect(priceBar({ kind: "qty", qty: 3, dt: "fixed_total", dv: 50 }, unit).total).toBe(5000);
    expect(priceBar({ kind: "qty", qty: 2, dt: "fixed_total", dv: 100 }, unit).total).toBe(4000);
  });

  test("buy X get Y: free, percentage, amount and fixed price on the Y units", () => {
    const bxgy = (dt: "none" | "percentage" | "amount" | "fixed_total", dv: number) =>
      priceBar({ kind: "bxgy", qty: 3, get: 1, dt, dv }, unit).total;
    expect(bxgy("none", 0)).toBe(4000);
    expect(bxgy("percentage", 50)).toBe(5000);
    expect(bxgy("amount", 5)).toBe(5500);
    expect(bxgy("fixed_total", 5)).toBe(4500);
  });

  test("compare-at price raises the full price and the saving", () => {
    const p = priceBar({ kind: "qty", qty: 2, dt: "none", dv: 0 }, unit, 2500);
    expect(p.full).toBe(5000);
    expect(p.saved).toBe(1000);
  });
});

describe("money and text", () => {
  test("Shopify money formats", () => {
    expect(formatMoney(123456)).toBe("$1,234.56");
    expect(formatMoney(123456, "{{amount_no_decimals}} kr")).toBe("1,235 kr");
    expect(formatMoney(123456, "€{{amount_with_comma_separator}}")).toBe("€1.234,56");
    expect(formatMoney(123456, "{{amount_no_decimals_with_comma_separator}}")).toBe("1.235");
    expect(formatMoney(123456, "CHF {{amount_with_apostrophe_separator}}")).toBe("CHF 1'234.56");
    expect(moneyToCents("12.50", 1.5)).toBe(1875);
    expect(moneyToCents(null)).toBe(0);
  });

  test("variables, unknown ones kept, HTML escaped when asked", () => {
    expect(renderText("Save {{ saved_amount }} on {{x}}", { saved_amount: "$5" })).toBe("Save $5 on {{x}}");
    expect(renderText("<b>{{p}}</b>", { p: "<i>" }, escapeHtml)).toBe("&lt;b&gt;&lt;i&gt;&lt;/b&gt;");
  });
});

describe("tiers", () => {
  test("targeting", () => {
    const has = (c: number) => c === 5;
    expect(matchesTarget({ tt: "ALL" }, 1, has)).toBe(true);
    expect(matchesTarget({ tt: "PRODUCTS", p: [1] }, 1, has)).toBe(true);
    expect(matchesTarget({ tt: "EXCEPT", p: [1] }, 1, has)).toBe(false);
    expect(matchesTarget({ tt: "COLLECTIONS", c: [4, 5] }, 1, has)).toBe(true);
    expect(matchesTarget({ tt: "COLLECTIONS", c: [4] }, 1, has)).toBe(false);
    expect(matchesTarget({ tt: "COLLECTIONS", c: [4] }, 1, () => null)).toBeNull();
  });

  test("highest reached bar; ties go to the picked bar, else the first", () => {
    const bars = [
      { id: "a", q: 1 },
      { id: "b", q: 2 },
      { id: "c", q: 2 },
      { id: "d", q: 4 },
    ];
    expect(reachedBar(bars, 0)).toBeNull();
    expect(reachedBar(bars, 3)?.id).toBe("b");
    expect(reachedBar(bars, 3, "c")?.id).toBe("c");
    expect(reachedBar(bars, 3, "d")?.id).toBe("b");
    expect(reachedBar(bars, 9)?.id).toBe("d");
  });
});

describe("cart planning", () => {
  const config: GiftConfig = {
    deals: [{ id: "d1", tt: "ALL", bars: [{ id: "b1", q: 1 }, { id: "b3", q: 3, gift: 555 }] }],
  };
  const line = (key: string, variant: number, quantity: number, properties: Record<string, string> = {}) => ({
    key,
    product_id: variant === 555 ? 900 : 1,
    variant_id: variant,
    quantity,
    properties,
  });
  const cart = (...items: ReturnType<typeof line>[]): AjaxCart => ({ token: "t", items });

  test("adds an earned gift, removes an unearned one", () => {
    expect(planGifts(config, cart(line("a", 11, 3)), {})?.adds).toEqual([
      { key: "d1|555", id: 555, quantity: 1, properties: { _cartlift_gift: "d1" } },
    ]);
    expect(planGifts(config, cart(line("a", 11, 2), line("g", 555, 1, { _cartlift_gift: "d1" })), {})?.updates).toEqual({ g: 0 });
  });

  test("merges a plain line into the tagged line of the same variant", () => {
    expect(mergePlan(cart(line("t", 11, 1, { _cartlift: "d1" }), line("p", 11, 2)))).toEqual({ p: 0, t: 3 });
    expect(mergePlan(cart(line("t", 11, 1, { _cartlift: "d1" }), line("p", 12, 2)))).toEqual({});
  });
});

describe("Phase 2 rules", () => {
  test("dealMatches: the deal's targeting or its mix & match pool", () => {
    const deal = { tt: "PRODUCTS" as const, p: [1], mm: { tt: "COLLECTIONS" as const, c: [5] } };
    expect(dealMatches(deal, 1, () => false)).toBe(true);
    expect(dealMatches(deal, 2, (c) => c === 5)).toBe(true);
    expect(dealMatches(deal, 2, () => false)).toBe(false);
    expect(dealMatches(deal, 2, () => null)).toBeNull();
  });

  test("bundleSets: complete sets and which units form them", () => {
    const items = [{ v: null, q: 1 }, { v: 70, q: 2 }];
    const lines = [
      { line: "main", variant: 11, qty: 3, main: true },
      { line: "capA", variant: 70, qty: 3, main: true },
      { line: "capB", variant: 70, qty: 2, main: true },
    ];
    const match = bundleSets(items, lines);
    // 5 caps → 2 sets of 2; 3 mains → 2 used. A cap line isn't a "main" even if eligible.
    expect(match.sets).toBe(2);
    expect(match.items[0]).toEqual([{ line: "main", qty: 2 }]);
    expect(match.items[1]).toEqual([{ line: "capA", qty: 3 }, { line: "capB", qty: 1 }]);
    expect(bundleSets(items, [lines[0]]).sets).toBe(0);
  });

  test("priceBundle and priceMixed", () => {
    expect(priceBundle([{ unit: 2000, q: 1, dt: "none", dv: 0 }, { unit: 2000, q: 1, dt: "percentage", dv: 25 }])).toEqual({
      total: 3500,
      full: 4000,
      saved: 500,
      savedPct: 13,
    });
    expect(priceMixed({ kind: "qty", qty: 3, dt: "percentage", dv: 10 }, [2000, 1200, 1600]).total).toBe(4320);
    expect(priceMixed({ kind: "qty", qty: 2, dt: "amount", dv: 15 }, [2000, 1000]).total).toBe(500);
    expect(priceMixed({ kind: "bxgy", qty: 3, get: 1, dt: "percentage", dv: 100 }, [2000, 1200, 1600]).total).toBe(3600);
  });
});
