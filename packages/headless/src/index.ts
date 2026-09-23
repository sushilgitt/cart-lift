import { matchesTarget, priceBar, priceBundle, type DiscountType } from "../../core/src";

/**
 * CartLift for headless storefronts (Hydrogen, Next, anything that builds its
 * own cart).
 *
 * A headless storefront renders its own product page, so it cannot use the
 * theme widget — but the *contract* with checkout is the same: the discount
 * Function reads line attributes (`_cartlift`, `_cartlift_bar`, `_cartlift_gift`
 * …), and prices every line from them. This module produces exactly those
 * lines, so a headless store gets the same discounts as a Liquid one.
 *
 * Pure TypeScript, no framework: `react.tsx` next to this file has an optional
 * component for rendering the bars.
 */

/** The published storefront config (the `cartlift/deals` app metafield). */
export interface CartLiftConfig {
  v: number;
  deals: CartLiftDeal[];
}

export interface CartLiftDeal {
  id: string;
  name: string;
  tt: "ALL" | "PRODUCTS" | "COLLECTIONS" | "EXCEPT";
  p: number[];
  c: number[];
  s: string | null;
  e: string | null;
  bars: CartLiftBar[];
  ctry?: string[];
  sub?: { on: boolean; apply: "b" | "s" | "o"; one: string; sub: string; pre: "one" | "sub" };
  style?: Record<string, unknown>;
}

export interface CartLiftBar {
  id: string;
  kind: "qty" | "bxgy" | "bundle";
  qty: number;
  get: number;
  dt: DiscountType;
  dv: number;
  title: string;
  subtitle: string;
  badge: string;
  selected: boolean;
  gifts?: { id: number; title: string }[];
  items?: { v: number | null; q: number; dt: DiscountType; dv: number; price?: string | null }[];
}

/** A product as a headless storefront knows it (ids are numbers, like the Ajax API). */
export interface HeadlessProduct {
  id: number;
  collectionIds?: number[];
}

/** A cart line, in the shape the Storefront API's cartLinesAdd takes. */
export interface CartLiftLine {
  merchandiseId: string;
  quantity: number;
  attributes: { key: string; value: string }[];
  sellingPlanId?: string;
}

const gid = (type: "ProductVariant" | "SellingPlan", id: number | string) =>
  String(id).startsWith("gid://") ? String(id) : `gid://shopify/${type}/${id}`;

/**
 * The deal that applies to a product right now: the first one whose targeting,
 * schedule and market match. Deals are published in priority order.
 */
export function dealFor(
  config: CartLiftConfig | null | undefined,
  product: HeadlessProduct,
  options: { country?: string; now?: Date } = {},
): CartLiftDeal | null {
  const now = options.now ?? new Date();
  const collections = product.collectionIds ?? [];
  for (const deal of config?.deals ?? []) {
    if (deal.s && new Date(deal.s) > now) continue;
    if (deal.e && new Date(deal.e) < now) continue;
    if (deal.ctry?.length && !(options.country && deal.ctry.includes(options.country))) continue;
    if (!matchesTarget({ tt: deal.tt, p: deal.p, c: deal.c }, product.id, (c) => collections.includes(Number(c)))) continue;
    return deal;
  }
  return null;
}

/** The bar a shopper sees selected when the page opens. */
export const initialBar = (deal: CartLiftDeal): CartLiftBar | undefined =>
  deal.bars.find((b) => b.selected) ?? deal.bars[0];

export interface BarPrice {
  /** What the bar costs in total, in cents. */
  total: number;
  /** What it would cost without the deal. */
  full: number;
  saved: number;
  savedPct: number;
  /** Per unit, for "… / each". */
  unit: number;
}

/**
 * What a bar costs for a product at `unitPrice` (cents). The same arithmetic the
 * widget and the Function use, so the price a shopper is shown is the price
 * checkout charges.
 */
export function barPrice(bar: CartLiftBar, unitPrice: number, compareAt = 0): BarPrice {
  const priced =
    bar.kind === "bundle"
      ? priceBundle(
          (bar.items ?? []).map((item) => ({
            unit: item.v == null ? unitPrice : Number(item.price ?? 0),
            q: item.q,
            dt: item.dt,
            dv: item.dv,
          })),
          1,
        )
      : priceBar(bar, unitPrice, compareAt, 1);
  const quantity = bar.kind === "bundle" ? (bar.items ?? []).reduce((sum, i) => sum + i.q, 0) : bar.qty;
  return {
    total: priced.total,
    full: priced.full,
    saved: priced.saved,
    savedPct: priced.savedPct,
    unit: Math.round(priced.total / Math.max(1, quantity)),
  };
}

export interface LineOptions {
  /** The variant the shopper is buying (one id, or one per unit). */
  variantId: number | string;
  variantIds?: (number | string)[];
  /** A selling plan, when the shopper subscribed. */
  sellingPlanId?: number | string | null;
  /** The A/B arm this visitor is in; "A" when there is no test. */
  arm?: string;
}

/**
 * The cart lines for a bar: the product itself, plus the free gifts it unlocks.
 *
 * The attributes are the contract with checkout — change them here and the
 * Discount Function stops recognising the lines.
 */
export function linesFor(deal: CartLiftDeal, bar: CartLiftBar, options: LineOptions): CartLiftLine[] {
  const arm = options.arm || "A";
  // Two bars with the same quantity need the bar named, or checkout can't tell
  // which one the shopper picked.
  const tied = deal.bars.some((b, i) => deal.bars.some((o, j) => j !== i && o.qty === b.qty));
  const attributes = [
    { key: "_cartlift", value: deal.id },
    { key: "_cartlift_arm", value: arm },
    ...(tied ? [{ key: "_cartlift_bar", value: bar.id }] : []),
  ];
  const plan = options.sellingPlanId != null ? { sellingPlanId: gid("SellingPlan", options.sellingPlanId) } : {};
  const lines: CartLiftLine[] = [];

  if (bar.kind === "bundle") {
    const tag = `${deal.id}:${bar.id}`;
    for (const item of bar.items ?? []) {
      const id = item.v == null ? options.variantId : item.v;
      const own = [
        { key: "_cartlift_bundle", value: tag },
        { key: "_cartlift_arm", value: arm },
        ...(item.v == null ? [{ key: "_cartlift_main", value: "1" }] : []),
      ];
      const same = lines.find((l) => l.merchandiseId === gid("ProductVariant", id) && sameAttributes(l.attributes, own));
      if (same) same.quantity += item.q;
      else lines.push({ merchandiseId: gid("ProductVariant", id), quantity: item.q, attributes: own, ...(item.v == null ? plan : {}) });
    }
  } else {
    // One line per distinct variant, like the widget does for per-unit pickers.
    const counts = new Map<string, number>();
    for (let i = 0; i < bar.qty; i++) {
      const id = String(options.variantIds?.[i] ?? options.variantId);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    for (const [id, quantity] of counts) {
      lines.push({ merchandiseId: gid("ProductVariant", id), quantity, attributes, ...plan });
    }
  }

  // Gifts are one-time items, never subscriptions, and always a single unit.
  for (const gift of bar.gifts ?? []) {
    lines.push({
      merchandiseId: gid("ProductVariant", gift.id),
      quantity: 1,
      attributes: [{ key: "_cartlift_gift", value: deal.id }],
    });
  }
  return lines;
}

const sameAttributes = (a: CartLiftLine["attributes"], b: CartLiftLine["attributes"]) =>
  JSON.stringify(a) === JSON.stringify(b);

/** The selling plans a variant can be bought on, from the Storefront API shape. */
export interface HeadlessAllocation {
  sellingPlan: { id: string; name: string };
  price: { amount: string };
}

/** Plans the shopper can pick, and what each costs (cents), when the deal offers them. */
export function plansFor(deal: CartLiftDeal, allocations: HeadlessAllocation[] = []) {
  if (!deal.sub?.on) return [];
  return allocations.map((a) => ({
    id: a.sellingPlan.id,
    name: a.sellingPlan.name,
    price: Math.round(Number(a.price.amount) * 100),
  }));
}
