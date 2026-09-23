import { describe, expect, test } from "vitest";
import {
  armConfig,
  liveArms,
  newBar,
  normalizeConfig,
  normalizeStrings,
  storefrontDeal,
  translatableTexts,
  translationFromTexts,
  validateConfig,
} from "./deals";

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

describe("translations", () => {
  const config = () =>
    normalizeConfig({
      ...base(),
      style: { blockTitle: "BUNDLE & SAVE", savingsBar: { enabled: true, text: "You save {{saved_amount}}" } },
      mixMatch: { enabled: true, pool: "visibility", modalTitle: "Pick", buttonText: "Add" },
      bars: [
        newBar({ id: "b1", title: "Single", subtitle: "Standard", highlights: ["Free shipping", "30-day returns"] }),
        newBar({ id: "b2", qty: 2, title: "Duo", badge: "Popular", gifts: [{ id: "gid://shopify/ProductVariant/9", title: "Socks", productId: "p" }], giftText: "+ FREE gift" }),
      ],
    });

  test("every translatable text, and back again", () => {
    const texts = translatableTexts(config());
    expect(Object.keys(texts)).toEqual([
      "blockTitle", "savingsText", "modalTitle", "modalButton",
      "bars.b1.title", "bars.b1.subtitle", "bars.b1.highlights.0", "bars.b1.highlights.1",
      "bars.b2.title", "bars.b2.badge", "bars.b2.giftText",
    ]);
    const translated = translationFromTexts({
      blockTitle: "SPAREN",
      "bars.b1.title": "Einzeln",
      "bars.b1.highlights.1": "30 Tage Rückgabe",
      "bars.b2.giftText": "+ GRATIS Geschenk",
      "upsells.u1": "Mütze",
      "bars.b2.title": "",
    });
    expect(translated.blockTitle).toBe("SPAREN");
    expect(translated.bars).toEqual({ b1: { title: "Einzeln", highlights: [undefined, "30 Tage Rückgabe"] }, b2: { giftText: "+ GRATIS Geschenk" } });
    expect(translated.upsells).toEqual({ u1: "Mütze" });
  });

  test("normalizing keeps known languages and known string keys only", () => {
    const c = normalizeConfig({ ...base(), translations: { de: { blockTitle: "X" }, "not a locale": { blockTitle: "Y" } } });
    expect(Object.keys(c.translations)).toEqual(["de"]);
    expect(normalizeStrings({ de: { each: "/ Stück", nonsense: "x", soldOut: "" } })).toEqual({ de: { each: "/ Stück" } });
    expect(normalizeStrings({ de: {} })).toEqual({});
  });
});

describe("subscriptions", () => {
  test("old deals stay one-time-and-subscription alike, and publish nothing extra", () => {
    const c = normalizeConfig(base());
    expect(c.subscriptions).toEqual({
      enabled: false,
      apply: "both",
      onetimeLabel: "One-time purchase",
      subscribeLabel: "Subscribe & save",
      preselect: "onetime",
    });
    expect(storefrontDeal(deal(c))).not.toHaveProperty("sub");
  });

  test("what the widget is told", () => {
    const c = normalizeConfig({ ...base(), subscriptions: { enabled: true, apply: "subscription", subscribeLabel: "Abonnieren", preselect: "subscribe" } });
    expect(storefrontDeal(deal(c))).toMatchObject({
      sub: { on: true, apply: "s", one: "One-time purchase", sub: "Abonnieren", pre: "sub" },
    });
    // A deal that only skips one kind of purchase needs no picker.
    const quiet = normalizeConfig({ ...base(), subscriptions: { apply: "onetime" } });
    expect(storefrontDeal(deal(quiet))).toMatchObject({ sub: { on: false, apply: "o" } });
  });

  test("nonsense settings fall back", () => {
    const c = normalizeConfig({ ...base(), subscriptions: { apply: "weekly", preselect: 7, onetimeLabel: "" } });
    expect(c.subscriptions).toMatchObject({ apply: "both", preselect: "onetime", onetimeLabel: "One-time purchase" });
  });

  test("the picker's texts can be translated", () => {
    const on = normalizeConfig({ ...base(), subscriptions: { enabled: true } });
    expect(translatableTexts(on)).toMatchObject({ onetimeLabel: "One-time purchase", subscribeLabel: "Subscribe & save" });
    const off = normalizeConfig(base());
    expect(translatableTexts(off)).not.toHaveProperty("subscribeLabel");
    expect(translationFromTexts({ subscribeLabel: "Abonnieren" })).toMatchObject({ subscribeLabel: "Abonnieren" });
  });
});
