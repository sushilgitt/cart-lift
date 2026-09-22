/**
 * Analytics formulas (Kaching's Analytics 2.0 metric set) and the A/B test
 * statistics. One module so the dashboard, analytics page, CSV export and A/B
 * results always agree.
 */

export interface Totals {
  views: number;
  addToCarts: number;
  checkouts: number;
  orders: number;
  eligibleOrders: number;
  subscribedOrders: number;
  units: number;
  revenue: number;
  addedRevenue: number;
  cost: number;
}

export const emptyTotals = (): Totals => ({
  views: 0,
  addToCarts: 0,
  checkouts: 0,
  orders: 0,
  eligibleOrders: 0,
  subscribedOrders: 0,
  units: 0,
  revenue: 0,
  addedRevenue: 0,
  cost: 0,
});

export function addTotals(into: Totals, row: Partial<Record<keyof Totals, unknown>>): Totals {
  for (const k of Object.keys(into) as (keyof Totals)[]) into[k] += Number(row[k] ?? 0) || 0;
  return into;
}

const ratio = (a: number, b: number) => (b ? a / b : 0);

/** The 15 metrics. Rates are fractions (0.12 = 12%); money in shop currency units. */
export function metrics(t: Totals) {
  const profit = t.revenue - t.cost;
  return {
    revenue: t.revenue,
    addedRevenue: t.addedRevenue,
    bundleOrders: t.orders,
    visitors: t.views,
    /** Bundle conversion: deal orders per visitor. */
    conversion: ratio(t.orders, t.views),
    /** Visitor conversion: any order from a visitor who saw the deal. */
    visitorConversion: ratio(t.eligibleOrders, t.views),
    aov: ratio(t.revenue, t.orders),
    revenuePerVisitor: ratio(t.revenue, t.views),
    /** Only meaningful when costs are set; null otherwise. */
    profitPerVisitor: t.cost > 0 ? ratio(profit, t.views) : null,
    profitability: t.cost > 0 ? ratio(profit, t.revenue) : null,
    addToCarts: t.addToCarts,
    atcRate: ratio(t.addToCarts, t.views),
    checkoutRate: ratio(t.checkouts, t.views),
    subscribed: t.subscribedOrders,
    subscriptionRate: ratio(t.subscribedOrders, t.orders),
    unitsPerOrder: ratio(t.units, t.orders),
  };
}

export type Metrics = ReturnType<typeof metrics>;

/** % change from `before` to `now`; null when there's no base. */
export const change = (now: number, before: number) => (before ? (now - before) / Math.abs(before) : null);

// ---------------------------------------------------------------------------
// A/B statistics
// ---------------------------------------------------------------------------

/** Standard normal CDF (Abramowitz & Stegun 7.1.26, |error| < 1.5e-7). */
function normalCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * (Math.abs(z) / Math.SQRT2));
  const erf =
    1 - t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) *
      Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

/** Two-proportion z-test on conversion (orders / visitors). Two-sided p-value. */
export function zTest(a: { visitors: number; orders: number }, b: { visitors: number; orders: number }) {
  if (!a.visitors || !b.visitors) return { z: 0, p: 1 };
  const p1 = a.orders / a.visitors;
  const p2 = b.orders / b.visitors;
  const pooled = (a.orders + b.orders) / (a.visitors + b.visitors);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / a.visitors + 1 / b.visitors));
  if (!se) return { z: 0, p: 1 };
  const z = (p2 - p1) / se;
  return { z, p: 2 * (1 - normalCdf(Math.abs(z))) };
}

export const MIN_ORDERS_PER_ARM = 10;
export const SIGNIFICANCE = 0.05;

export interface ArmResult {
  key: string;
  visitors: number;
  orders: number;
  conversion: number;
  /** Relative lift in conversion vs arm A (null for A or when A has none). */
  lift: number | null;
  /** p-value vs arm A (1 for A). */
  p: number;
}

/**
 * Winner by conversion rate. Every arm needs ≥10 orders; the best arm must beat
 * every other arm with p < 0.05. Otherwise "no clear winner" (or not enough data).
 */
export function abResult(arms: { key: string; visitors: number; orders: number }[]) {
  const control = arms.find((a) => a.key === "A") ?? arms[0];
  const rows: ArmResult[] = arms.map((a) => {
    const conversion = a.visitors ? a.orders / a.visitors : 0;
    const base = control && control.visitors ? control.orders / control.visitors : 0;
    return {
      ...a,
      conversion,
      lift: a === control || !base ? null : (conversion - base) / base,
      p: a === control ? 1 : zTest(control, a).p,
    };
  });
  if (arms.length < 2 || arms.some((a) => a.orders < MIN_ORDERS_PER_ARM)) {
    return { status: "collecting" as const, winner: null, arms: rows };
  }
  const best = [...rows].sort((x, y) => y.conversion - x.conversion)[0];
  const beatsAll = rows.every((r) => r === best || zTest(r, best).p < SIGNIFICANCE);
  return beatsAll
    ? { status: "winner" as const, winner: best.key, arms: rows }
    : { status: "no_clear_winner" as const, winner: null, arms: rows };
}
