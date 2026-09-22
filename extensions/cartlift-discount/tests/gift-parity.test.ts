import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, test } from "vitest";
import { cartLinesDiscountsGenerateRun, type FnConfig } from "../src/cart_lines_discounts_generate_run";
import { DiscountClass } from "../generated/api";

/**
 * The storefront cart watcher (cartlift-widget/assets/cartlift-cart.js) adds
 * and removes free gifts on its own reading of the cart. These tests run the
 * same carts through it and through this Function, and check they agree:
 * every gift the watcher keeps is free at checkout, and every gift it removes
 * would have been charged.
 */

type Plan = {
  want: Record<string, { deal: string; variant: number }>;
  present: string[];
  updates: Record<string, number>;
  adds: { key: string; id: number; quantity: number; properties: Record<string, string> }[];
};
type PlanFn = (config: unknown, cart: unknown, cols: Record<number, number[]>, skip?: Record<string, boolean>) => Plan | null;

function loadWatcher(): PlanFn {
  const file = fileURLToPath(new URL("../../cartlift-widget/assets/cartlift-cart.js", import.meta.url));
  const window: Record<string, unknown> = {};
  const document = { querySelectorAll: () => [] };
  vm.runInNewContext(readFileSync(file, "utf8"), { window, document });
  return (window.CartLiftCart as { plan: PlanFn }).plan;
}
const plan = loadWatcher();

// One deal definition, published both ways like app/lib/sync.server.ts does.
interface DealSpec {
  id: string;
  tt: "ALL" | "PRODUCTS" | "COLLECTIONS" | "EXCEPT";
  p?: number[];
  c?: number[];
  across?: boolean;
  bars: { id?: string; q: number; pct?: number; gift?: number }[];
}

const gid = (type: string, id: number) => `gid://shopify/${type}/${id}`;

function fnConfig(deals: DealSpec[]): FnConfig {
  return {
    collectionIds: [...new Set(deals.filter((d) => d.tt === "COLLECTIONS").flatMap((d) => d.c ?? []))].map((c) =>
      gid("Collection", c),
    ),
    deals: deals.map((d) => ({
      id: d.id,
      tt: d.tt,
      p: (d.p ?? []).map((p) => gid("Product", p)),
      c: (d.c ?? []).map((c) => gid("Collection", c)),
      across: Boolean(d.across),
      name: d.id,
      bars: d.bars.map((b, i) => ({
        id: b.id ?? `${d.id}-b${i}`,
        q: b.q,
        k: "q" as const,
        dt: b.pct ? ("percentage" as const) : ("none" as const),
        dv: b.pct ?? 0,
        ...(b.gift ? { gift: gid("ProductVariant", b.gift) } : {}),
      })),
    })),
  };
}

function giftConfig(deals: DealSpec[]) {
  const out = deals.map((d) => ({
    id: d.id,
    tt: d.tt,
    p: d.p ?? [],
    c: d.c ?? [],
    across: Boolean(d.across),
    bars: d.bars.map((b, i) => ({ id: b.id ?? `${d.id}-b${i}`, q: b.q, ...(b.gift ? { gift: b.gift } : {}) })),
  }));
  return { v: 1, g: out.some((d) => d.bars.some((b) => b.gift)), deals: out };
}

interface Line {
  key: string;
  product: number;
  variant: number;
  qty: number;
  price?: number;
  deal?: string;
  bar?: string;
  gift?: string;
  upsell?: string;
}

/** The /cart.js shape. */
const ajaxCart = (lines: Line[]) => ({
  token: "t1",
  items: lines.map((l) => ({
    key: l.key,
    product_id: l.product,
    variant_id: l.variant,
    quantity: l.qty,
    properties: {
      ...(l.deal ? { _cartlift: l.deal } : {}),
      ...(l.bar ? { _cartlift_bar: l.bar } : {}),
      ...(l.gift ? { _cartlift_gift: l.gift } : {}),
      ...(l.upsell ? { _cartlift_upsell: l.upsell } : {}),
    },
  })),
});

/** Gift lines the Function makes free, as line key → free units. */
function freeGifts(deals: DealSpec[], lines: Line[], cols: Record<number, number[]>) {
  const config = fnConfig(deals);
  const ids = config.collectionIds ?? [];
  const result = cartLinesDiscountsGenerateRun({
    presentmentCurrencyRate: "1",
    cart: {
      lines: lines.map((l) => ({
        id: l.key,
        quantity: l.qty,
        cost: { amountPerQuantity: { amount: String(l.price ?? 20) } },
        deal: l.deal ? { value: l.deal } : null,
        arm: null,
        bar: l.bar ? { value: l.bar } : null,
        gift: l.gift ? { value: l.gift } : null,
        upsell: l.upsell ? { value: l.upsell } : null,
        merchandise: {
          __typename: "ProductVariant",
          id: gid("ProductVariant", l.variant),
          product: {
            id: gid("Product", l.product),
            inCollections: ids.map((c) => ({
              collectionId: c,
              isMember: (cols[l.product] ?? []).map((n) => gid("Collection", n)).includes(c),
            })),
          },
        },
      })),
    },
    discount: { discountClasses: [DiscountClass.Product], metafield: { jsonValue: config } },
  } as never);

  const giftKeys = new Set(lines.filter((l) => l.gift).map((l) => l.key));
  const free: Record<string, number> = {};
  for (const op of result.operations) {
    for (const c of (op as { productDiscountsAdd?: { candidates: unknown[] } }).productDiscountsAdd?.candidates ?? []) {
      const cand = c as { targets: { cartLine: { id: string; quantity?: number } }[]; value: { percentage?: { value: number } } };
      for (const t of cand.targets) {
        if (giftKeys.has(t.cartLine.id) && cand.value.percentage?.value === 100) {
          free[t.cartLine.id] = (free[t.cartLine.id] ?? 0) + (t.cartLine.quantity ?? 1);
        }
      }
    }
  }
  return free;
}

/** Applies a plan to the cart like the watcher's update.js + add.js calls. */
function applyPlan(lines: Line[], p: Plan): Line[] {
  const next = lines
    .map((l) => (l.key in p.updates ? { ...l, qty: p.updates[l.key] } : l))
    .filter((l) => l.qty > 0);
  p.adds.forEach((a, i) =>
    next.push({ key: `added-${i}`, product: 900, variant: a.id, qty: a.quantity, gift: a.properties._cartlift_gift }),
  );
  return next;
}

/**
 * Runs the watcher, applies its changes, then checks against the Function:
 * every remaining gift line is exactly one free unit, and a second pass is a no-op.
 */
function reconcile(deals: DealSpec[], lines: Line[], cols: Record<number, number[]> = {}) {
  const config = giftConfig(deals);
  const p = plan(config, ajaxCart(lines), cols);
  expect(p).not.toBeNull();
  const after = applyPlan(lines, p!);

  const gifts = after.filter((l) => l.gift);
  const free = freeGifts(deals, after, cols);
  for (const g of gifts) {
    expect(g.qty, `gift line ${g.key} quantity`).toBe(1);
    expect(free[g.key] ?? 0, `gift line ${g.key} should be free at checkout`).toBe(1);
  }

  const again = plan(config, ajaxCart(after), cols)!;
  expect(again.adds).toEqual([]);
  expect(again.updates).toEqual({});
  return { plan: p!, after, gifts };
}

const GIFT = 555;
const giftDeal = (extra: Partial<DealSpec> = {}): DealSpec => ({
  id: "d1",
  tt: "ALL",
  bars: [{ q: 1 }, { q: 2, pct: 10 }, { q: 3, pct: 20, gift: GIFT }],
  ...extra,
});

describe("cart watcher agrees with the Discount Function", () => {
  test("adds the gift when two separate adds reach the gift bar", () => {
    const { gifts } = reconcile(
      [giftDeal()],
      [
        { key: "a", product: 1, variant: 11, qty: 1, deal: "d1" },
        { key: "b", product: 1, variant: 11, qty: 2 },
      ],
    );
    expect(gifts.map((g) => g.variant)).toEqual([GIFT]);
  });

  test("removes a gift whose bar is no longer reached", () => {
    const lines: Line[] = [
      { key: "a", product: 1, variant: 11, qty: 2, deal: "d1" },
      { key: "g", product: 900, variant: GIFT, qty: 1, gift: "d1" },
    ];
    // Without the watcher the shopper would pay for it.
    expect(freeGifts([giftDeal()], lines, {})).toEqual({});
    const { plan: p, gifts } = reconcile([giftDeal()], lines);
    expect(p.updates).toEqual({ g: 0 });
    expect(gifts).toEqual([]);
  });

  test("trims a gift to one unit and drops duplicate gift lines", () => {
    const { plan: p } = reconcile(
      [giftDeal()],
      [
        { key: "a", product: 1, variant: 11, qty: 3, deal: "d1" },
        { key: "g1", product: 900, variant: GIFT, qty: 2, gift: "d1" },
        { key: "g2", product: 900, variant: GIFT, qty: 1, gift: "d1" },
      ],
    );
    expect(p.updates).toEqual({ g1: 1, g2: 0 });
  });

  test("counts per product unless the deal counts across products", () => {
    const lines: Line[] = [
      { key: "a", product: 1, variant: 11, qty: 2 },
      { key: "b", product: 2, variant: 21, qty: 1 },
    ];
    expect(reconcile([giftDeal()], lines).gifts).toEqual([]);
    expect(reconcile([giftDeal({ across: true })], lines).gifts).toHaveLength(1);
  });

  test("an earlier deal without gifts claims the line first", () => {
    const deals: DealSpec[] = [
      { id: "d0", tt: "PRODUCTS", p: [1], bars: [{ q: 2, pct: 10 }] },
      giftDeal(),
    ];
    expect(reconcile(deals, [{ key: "a", product: 1, variant: 11, qty: 3 }]).gifts).toEqual([]);
    // A line tagged for the gift deal goes to it.
    expect(reconcile(deals, [{ key: "a", product: 1, variant: 11, qty: 3, deal: "d1" }]).gifts).toHaveLength(1);
  });

  test("progressive gifts: only the highest reached bar's gift is kept", () => {
    const deal = giftDeal({ bars: [{ q: 1 }, { q: 2, gift: 444 }, { q: 3, gift: GIFT }] });
    const { plan: p, gifts } = reconcile(
      [deal],
      [
        { key: "a", product: 1, variant: 11, qty: 3, deal: "d1" },
        { key: "g", product: 900, variant: 444, qty: 1, gift: "d1" },
      ],
    );
    expect(p.updates).toEqual({ g: 0 });
    expect(gifts.map((g) => g.variant)).toEqual([GIFT]);
  });

  test("gift and upsell lines never count toward the tiers", () => {
    const { gifts } = reconcile(
      [giftDeal()],
      [
        { key: "a", product: 1, variant: 11, qty: 2, deal: "d1" },
        { key: "u", product: 1, variant: 11, qty: 1, upsell: "d1:u1" },
      ],
    );
    expect(gifts).toEqual([]);
  });

  test("targeting: selected products, all-except and collections", () => {
    const cart: Line[] = [{ key: "a", product: 1, variant: 11, qty: 3 }];
    expect(reconcile([giftDeal({ tt: "PRODUCTS", p: [1] })], cart).gifts).toHaveLength(1);
    expect(reconcile([giftDeal({ tt: "PRODUCTS", p: [2] })], cart).gifts).toEqual([]);
    expect(reconcile([giftDeal({ tt: "EXCEPT", p: [1] })], cart).gifts).toEqual([]);
    expect(reconcile([giftDeal({ tt: "COLLECTIONS", c: [7] })], cart, { 1: [7, 8] }).gifts).toHaveLength(1);
    expect(reconcile([giftDeal({ tt: "COLLECTIONS", c: [7] })], cart, { 1: [8] }).gifts).toEqual([]);
  });

  test("does nothing when a line's collections are unknown", () => {
    const config = giftConfig([giftDeal({ tt: "COLLECTIONS", c: [7] })]);
    expect(plan(config, ajaxCart([{ key: "a", product: 1, variant: 11, qty: 3 }]), {})).toBeNull();
  });

  test("removes gifts left from a deal that is no longer live", () => {
    const { plan: p } = reconcile(
      [giftDeal()],
      [
        { key: "a", product: 1, variant: 11, qty: 3, deal: "d1" },
        { key: "old", product: 900, variant: 777, qty: 1, gift: "gone" },
      ],
    );
    expect(p.updates).toEqual({ old: 0 });
  });

  test("bars sharing a quantity: the tagged bar's gift, else the first bar's", () => {
    const deal: DealSpec = {
      id: "d1",
      tt: "ALL",
      bars: [
        { id: "b1", q: 1 },
        { id: "gift-a", q: 2, pct: 10, gift: 444 },
        { id: "gift-b", q: 2, pct: 10, gift: GIFT },
      ],
    };
    const tagged = reconcile([deal], [{ key: "a", product: 1, variant: 11, qty: 2, deal: "d1", bar: "gift-b" }]);
    expect(tagged.gifts.map((g) => g.variant)).toEqual([GIFT]);
    const untagged = reconcile([deal], [{ key: "a", product: 1, variant: 11, qty: 2 }]);
    expect(untagged.gifts.map((g) => g.variant)).toEqual([444]);
    // Switching bars swaps the gift.
    const swap = reconcile(
      [deal],
      [
        { key: "a", product: 1, variant: 11, qty: 2, deal: "d1", bar: "gift-b" },
        { key: "g", product: 900, variant: 444, qty: 1, gift: "d1" },
      ],
    );
    expect(swap.plan.updates).toEqual({ g: 0 });
    expect(swap.gifts.map((g) => g.variant)).toEqual([GIFT]);
  });

  test("respects gifts the shopper dismissed", () => {
    const config = giftConfig([giftDeal()]);
    const p = plan(config, ajaxCart([{ key: "a", product: 1, variant: 11, qty: 3 }]), {}, { [`d1|${GIFT}`]: true });
    expect(p!.adds).toEqual([]);
  });
});
