import { describe, expect, test } from "vitest";
import {
  escapeHtml,
  formatMoney,
  matchesTarget,
  mergePlan,
  moneyToCents,
  planGifts,
  priceBar,
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
