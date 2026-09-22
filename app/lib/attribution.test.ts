import { describe, expect, test } from "vitest";
import { attributeOrder } from "./attribution";
import { shopDay } from "./days";
import { newBar, newBundleBar, normalizeConfig, type DealConfig } from "./deals";

const config = (changes: Partial<DealConfig> = {}): DealConfig => ({
  ...normalizeConfig(null),
  bars: [newBar({ id: "b1", qty: 1 }), newBar({ id: "b2", qty: 2 }), newBar({ id: "b3", qty: 3 })],
  ...changes,
});
const line = (o: Record<string, unknown>) => ({ k: "deal", p: "1", v: "11", q: 1, r: 20, ...o });

describe("order attribution", () => {
  test("the bar the order reached, per product like the Function", () => {
    const split = attributeOrder(config(), "A", [line({ q: 2, r: 36 }), line({ p: "2", v: "21", q: 3, r: 48 })], (v) => (v === "11" ? 8 : 0));
    expect(split.bar.get("b2")).toEqual({ orders: 1, units: 2, revenue: 36, cost: 16 });
    expect(split.bar.get("b3")).toEqual({ orders: 1, units: 3, revenue: 48, cost: 0 });
    expect([...split.product.keys()]).toEqual(["1", "2"]);
  });

  test("across products: one group; tied quantities use the tagged bar", () => {
    const tied = config({
      across: true,
      bars: [newBar({ id: "b1", qty: 1 }), newBar({ id: "plain", qty: 2 }), newBar({ id: "gifted", qty: 2 })],
    });
    const split = attributeOrder(tied, "A", [line({ q: 1, t: "gifted" }), line({ p: "2", v: "21", q: 1 })]);
    expect([...split.bar.keys()]).toEqual(["gifted"]);
    expect(split.bar.get("gifted")?.units).toBe(2);
  });

  test("an A/B arm uses its own bars", () => {
    const c = config();
    c.abTest = { ...c.abTest, status: "running", arms: { B: { bars: [newBar({ id: "x2", qty: 2 })] } }, weights: { A: 50, B: 50 } };
    expect([...attributeOrder(c, "B", [line({ q: 2 })]).bar.keys()]).toEqual(["x2"]);
    expect([...attributeOrder(c, "A", [line({ q: 2 })]).bar.keys()]).toEqual(["b2"]);
  });

  test("bundle bars, gifts, upsells and mix & match land in features", () => {
    const c = config({ bars: [newBar({ id: "b1", qty: 1 }), newBundleBar({ id: "set" })] });
    c.mixMatch = { ...c.mixMatch, enabled: true };
    const split = attributeOrder(c, "A", [
      line({ k: "bundle", b: "set", q: 1, r: 20 }),
      line({ k: "bundle", b: "set", p: "7", v: "70", q: 1, r: 15 }),
      line({ k: "gift", p: "9", v: "90", q: 1, r: 0 }),
      line({ k: "upsell", p: "8", v: "80", q: 1, r: 9 }),
      line({ q: 1 }),
      line({ p: "2", v: "21", q: 1 }),
    ]);
    expect(split.bar.get("set")).toEqual({ orders: 1, units: 2, revenue: 35, cost: 0 });
    expect(Object.fromEntries([...split.feature].map(([k, f]) => [k, f.orders]))).toEqual({ gift: 1, upsell: 1, bundle: 1, mix: 1 });
    expect(split.feature.get("upsell")?.revenue).toBe(9);
  });
});

describe("shop days", () => {
  test("the date in the shop's timezone", () => {
    const late = new Date("2026-09-22T23:30:00Z");
    expect(shopDay("UTC", late).toISOString()).toBe("2026-09-22T00:00:00.000Z");
    expect(shopDay("Asia/Kolkata", late).toISOString()).toBe("2026-09-23T00:00:00.000Z");
    expect(shopDay("America/Los_Angeles", late).toISOString()).toBe("2026-09-22T00:00:00.000Z");
    expect(shopDay("Not/AZone", late).toISOString()).toBe("2026-09-22T00:00:00.000Z");
  });
});
