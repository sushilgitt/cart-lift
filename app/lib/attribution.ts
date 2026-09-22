import { reachedBar } from "../../packages/core/src";
import { armConfig, type DealConfig } from "./deals";

/**
 * Splits one order's CartLift lines (reported by the web pixel) into the
 * analytics dimensions below a deal: which bar the order reached, which
 * products it bought, and which features (gift, upsell, bundle, mix & match)
 * it used. Bars are worked out with the Function's rules (same grouping,
 * same reached-bar choice), so a bar's orders are the orders it priced.
 */

export interface OrderLine {
  /** deal | bundle | gift | upsell */
  k: string;
  /** Product and variant ids (numeric strings). */
  p: string;
  v: string;
  q: number;
  /** Paid for the line, after discounts. */
  r: number;
  /** Bundle bar id (bundle lines). */
  b?: string;
  /** `_cartlift_bar`: the bar picked when two share a quantity. */
  t?: string;
}

export interface Fact {
  orders: number;
  units: number;
  revenue: number;
  cost: number;
}

export interface Attribution {
  bar: Map<string, Fact>;
  product: Map<string, Fact>;
  feature: Map<string, Fact>;
}

const add = (map: Map<string, Fact>, key: string, units: number, revenue: number, cost: number, countOrder = true) => {
  const f = map.get(key) ?? { orders: 0, units: 0, revenue: 0, cost: 0 };
  // One order per key per order, however many lines it has.
  if (countOrder && !f.orders) f.orders = 1;
  f.units += units;
  f.revenue += revenue;
  f.cost += cost;
  map.set(key, f);
};

export function attributeOrder(
  config: DealConfig,
  arm: string,
  lines: OrderLine[],
  costOf: (variantId: string) => number = () => 0,
): Attribution {
  const out: Attribution = { bar: new Map(), product: new Map(), feature: new Map() };
  const c = armConfig(config, arm);
  const tiers = c.bars.filter((b) => b.kind !== "bundle").map((b) => ({ id: b.id, q: b.qty }));
  const lineCost = (l: OrderLine) => costOf(l.v) * l.q;

  // Quantity / BXGY bars: group deal lines like the Function (per product, or all when `across`).
  const groups = new Map<string, OrderLine[]>();
  for (const l of lines.filter((x) => x.k === "deal")) {
    const key = config.across ? "all" : l.p;
    groups.set(key, [...(groups.get(key) ?? []), l]);
  }
  for (const group of groups.values()) {
    const units = group.reduce((s, l) => s + l.q, 0);
    const bar = reachedBar(tiers, units, group.find((l) => l.t)?.t);
    if (!bar) continue;
    add(out.bar, bar.id, units, group.reduce((s, l) => s + l.r, 0), group.reduce((s, l) => s + lineCost(l), 0));
  }
  // Bundle bars: the bar is on the line.
  for (const l of lines.filter((x) => x.k === "bundle" && x.b)) add(out.bar, l.b!, l.q, l.r, lineCost(l));

  // Products the deal sold (deal and bundle lines).
  for (const l of lines.filter((x) => x.k === "deal" || x.k === "bundle")) add(out.product, l.p, l.q, l.r, lineCost(l));

  // Features.
  for (const kind of ["gift", "upsell", "bundle"] as const) {
    for (const l of lines.filter((x) => x.k === kind)) add(out.feature, kind, l.q, l.r, lineCost(l));
  }
  const dealLines = lines.filter((x) => x.k === "deal");
  if (config.mixMatch.enabled && new Set(dealLines.map((l) => l.p)).size > 1) {
    for (const l of dealLines) add(out.feature, "mix", l.q, l.r, lineCost(l));
  }
  return out;
}
