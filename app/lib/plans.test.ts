import { describe, expect, test } from "vitest";

import { PLANS, TRIAL_DAYS, annualSaving, planById, planFrom } from "./plans";
import { planFor } from "./billing.server";

describe("plans", () => {
  test("tiers climb in price and in limit, so the cheapest match is always the right one", () => {
    for (let i = 1; i < PLANS.length; i++) {
      expect(PLANS[i].price, PLANS[i].name).toBeGreaterThan(PLANS[i - 1].price);
      expect(PLANS[i].limit, PLANS[i].name).toBeGreaterThan(PLANS[i - 1].limit);
    }
    expect(PLANS[0]).toMatchObject({ id: "FREE", price: 0, limit: 250 });
    expect(PLANS[PLANS.length - 1]).toMatchObject({ id: "PRO", price: 59.99, limit: 10_000 });
    expect(TRIAL_DAYS).toBe(7);
  });

  test("the prices are the ones we advertise", () => {
    expect(PLANS.map((p) => [p.name, p.price, p.annualPrice])).toEqual([
      ["Free", 0, 0],
      ["Starter", 14.99, 149.99],
      ["Scale", 29.99, 299.99],
      ["Pro", 59.99, 599.99],
    ]);
  });

  test("a year up front is ten months' money, and the toggle says so", () => {
    for (const plan of PLANS.filter((p) => p.price > 0)) {
      const saved = 1 - plan.annualPrice / (plan.price * 12);
      // Every paid plan saves the same ~17%, so one number on the toggle is honest.
      expect(saved, plan.name).toBeGreaterThan(0.16);
      expect(saved, plan.name).toBeLessThan(0.17);
    }
    // Rounded down, never overstating what the merchant saves.
    expect(annualSaving()).toBe(16);
  });

  test("the upgrade prompt suggests the cheapest plan that covers the month", () => {
    expect(planFrom(100)?.id).toBe("FREE");
    expect(planFrom(900)?.id).toBe("STARTER");
    expect(planFrom(1_000)?.id).toBe("STARTER"); // exactly at the limit still fits
    expect(planFrom(1_001)?.id).toBe("SCALE");
    expect(planFrom(10_000)?.id).toBe("PRO");
    // Past the biggest plan there is nothing left to suggest.
    expect(planFrom(12_000)).toBe(null);
  });

  test("plan handles from Shopify map back to a plan, monthly or annual", () => {
    for (const plan of PLANS) {
      expect(planFor(plan.handle), plan.handle).toBe(plan.id);
      expect(planFor(`${plan.handle}-annual`), plan.handle).toBe(plan.id);
      expect(planFor(plan.name), plan.name).toBe(plan.id);
    }
    expect(planFor("something-else")).toBe(null);
    expect(planFor(null)).toBe(null);
  });

  test("an unknown plan id falls back to Free rather than crashing the admin", () => {
    expect(planById("NOPE" as never).id).toBe("FREE");
  });

  test("a shop left on a retired tier reads as the closest plan we still sell", () => {
    // The database enum keeps FLEX20–FLEX50; nobody should be on one, but if
    // they are, they keep Pro's limits rather than dropping to Free.
    for (const retired of ["FLEX20", "FLEX30", "FLEX40", "FLEX50"] as const) {
      expect(planById(retired).id, retired).toBe("PRO");
    }
    expect(PLANS.map((p) => p.id)).not.toContain("FLEX20");
  });
});
