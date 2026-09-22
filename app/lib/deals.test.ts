import { describe, expect, test } from "vitest";
import { armConfig, liveArms, newBar, normalizeConfig, storefrontDeal, validateConfig } from "./deals";

const base = () => ({
  ...normalizeConfig(null),
  bars: [newBar({ id: "b1", qty: 1, title: "One" }), newBar({ id: "b2", qty: 2, title: "Two", discountType: "percentage", discountValue: 10 })],
});
const deal = (config: unknown) => ({
  id: "d1", name: "Deal", type: "QUANTITY_BREAK" as const, targetType: "ALL" as const,
  products: [], collections: [], startsAt: null, endsAt: null, config,
});

describe("A/B test model", () => {
  test("arms normalize like the deal; weights default to an even split", () => {
    const c = normalizeConfig({ ...base(), abTest: { status: "running", arms: { B: { bars: [{ qty: "2", title: "B two", discountValue: -5 }] } } } });
    expect(c.abTest.arms.B?.bars?.[0]).toMatchObject({ qty: 2, title: "B two", discountValue: 0 });
    expect(c.abTest.arms.B).not.toHaveProperty("style");
    expect(c.abTest.weights).toEqual({ A: 50, B: 50 });
    expect(liveArms(c)).toEqual(["A", "B"]);
  });

  test("armConfig: the arm's fields over the deal's", () => {
    const c = normalizeConfig({ ...base(), abTest: { status: "running", arms: { B: { discountName: "B deal" } } } });
    expect(armConfig(c, "B").discountName).toBe("B deal");
    expect(armConfig(c, "B").bars).toEqual(c.bars);
    expect(armConfig(c, "A")).toBe(c);
  });

  test("a running test needs a variant and a split of 100%, and valid variants", () => {
    const c = normalizeConfig({ ...base(), abTest: { status: "running", weights: { A: 60, B: 30 }, arms: { B: { bars: [{ qty: 1, title: "" }] } } } });
    const errors = validateConfig(c);
    expect(errors).toContain("A/B test: the traffic split must add up to 100% (now 90%).");
    expect(errors).toContain("Variant B: Bar 1: add a title.");
    const alone = normalizeConfig({ ...base(), abTest: { status: "running", arms: {} } });
    expect(validateConfig(alone)).toContain("A/B test: add at least one variant to test against A.");
  });

  test("arms are published only while the test runs", () => {
    const running = normalizeConfig({ ...base(), abTest: { status: "running", weights: { A: 50, B: 50 }, arms: { B: { bars: [newBar({ id: "x", qty: 3, title: "B" })] } } } });
    const sf = storefrontDeal(deal(running)) as { arms?: { key: string; weight: number; bars: { id: string }[] }[]; weightA?: number };
    expect(sf.weightA).toBe(50);
    expect(sf.arms?.map((a) => [a.key, a.weight, a.bars.map((b) => b.id)])).toEqual([["B", 50, ["x"]]]);
    const ended = normalizeConfig({ ...running, abTest: { ...running.abTest, status: "ended" } });
    expect(storefrontDeal(deal(ended))).not.toHaveProperty("arms");
  });
});
