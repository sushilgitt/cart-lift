import { matchesTarget, type Targeted } from "./tiers";
import { amountEach, type DiscountType, type PricedBar } from "./pricing";

/**
 * Rules for the Phase 2 templates, shared by the Discount Function, the cart
 * watcher and the widget.
 *
 *  - Mix & match: a deal can have a product pool (`mm`) whose products also
 *    count toward its tiers.
 *  - Complete the bundle: a "bundle" bar is the viewed product plus
 *    hand-picked items, each with its own discount; only complete sets count.
 */

/** Whether a product counts for a deal: its targeting, or its mix & match pool. Null = unsure. */
export function dealMatches<Id>(
  deal: Targeted<Id> & { mm?: Targeted<Id> | null },
  productId: Id,
  inCollection: (collectionId: Id) => boolean | null,
): boolean | null {
  const own = matchesTarget(deal, productId, inCollection);
  if (own) return true;
  if (!deal.mm) return own;
  const pool = matchesTarget(deal.mm, productId, inCollection);
  if (pool) return true;
  return own === null || pool === null ? null : false;
}

/** A bundle item: a fixed variant, or `v: null` for the viewed (main) product. */
export interface BundleItem<Id> {
  v: Id | null;
  q: number;
}

/** A cart line tagged for one bundle bar. `main`: could be the main product. */
export interface BundleLine<Id, L> {
  line: L;
  variant: Id;
  qty: number;
  main: boolean;
}

export interface BundleMatch<L> {
  /** Complete sets in the cart. */
  sets: number;
  /** Per item (same order): the discounted units on each line. */
  items: { line: L; qty: number }[][];
}

/**
 * Complete sets of a bundle bar among the lines tagged for it, and which units
 * of which lines form them. A line serves one item: its fixed variant, else the
 * main product slot.
 */
export function bundleSets<Id, L>(items: BundleItem<Id>[], lines: BundleLine<Id, L>[]): BundleMatch<L> {
  const fixed = new Set(items.filter((i) => i.v != null).map((i) => String(i.v)));
  const pools = items.map((item) =>
    lines.filter((l) => (item.v == null ? l.main && !fixed.has(String(l.variant)) : String(l.variant) === String(item.v))),
  );
  let sets = Infinity;
  items.forEach((item, i) => {
    const q = Math.max(1, Math.floor(item.q));
    const available = pools[i].reduce((sum, l) => sum + l.qty, 0);
    sets = Math.min(sets, Math.floor(available / q));
  });
  if (!items.length || !Number.isFinite(sets)) sets = 0;

  const allocation = items.map((item, i) => {
    let need = sets * Math.max(1, Math.floor(item.q));
    const out: { line: L; qty: number }[] = [];
    for (const l of pools[i]) {
      if (need <= 0) break;
      const qty = Math.min(need, l.qty);
      need -= qty;
      out.push({ line: l.line, qty });
    }
    return out;
  });
  return { sets, items: allocation };
}

/** Discount on one unit, in cents. Amounts (`dv`) are in shop currency. */
export function unitOff(dt: DiscountType, dv: number, unit: number, rate = 1): number {
  const v = Math.max(0, Number(dv) || 0);
  if (dt === "percentage") return (unit * Math.min(v, 100)) / 100;
  if (dt === "amount") return Math.min(v * 100 * rate, unit);
  if (dt === "fixed_total") return Math.max(0, unit - v * 100 * rate); // fixed price each
  return 0;
}

export interface BundlePrice {
  total: number;
  full: number;
  saved: number;
  savedPct: number;
}

/** Price of one complete bundle set: each item's unit price (cents) × qty, less its discount. */
export function priceBundle(items: { unit: number; q: number; dt: DiscountType; dv: number }[], rate = 1): BundlePrice {
  let full = 0;
  let total = 0;
  for (const item of items) {
    const q = Math.max(1, Math.floor(item.q));
    full += item.unit * q;
    total += (item.unit - unitOff(item.dt, item.dv, item.unit, rate)) * q;
  }
  total = Math.round(total);
  const saved = Math.max(0, full - total);
  return { total, full, saved, savedPct: full > 0 ? Math.round((saved / full) * 100) : 0 };
}

/**
 * A quantity or BXGY bar priced for units of different prices (mix & match),
 * as checkout does: percentage/amount on every unit, a fixed total for all,
 * BXGY on the cheapest units.
 */
export function priceMixed(bar: PricedBar, units: number[], rate = 1): BundlePrice {
  const full = units.reduce((s, u) => s + u, 0);
  const v = Math.max(0, Number(bar.dv) || 0);
  let total = full;
  if (bar.kind === "bxgy") {
    const q = Math.max(1, bar.qty);
    const get = Math.min(bar.get || 0, q - 1);
    const free = Math.floor(units.length / q) * get;
    const cheapest = [...units].sort((a, b) => a - b).slice(0, free);
    const each = (u: number) => (bar.dt === "none" ? u : unitOff(bar.dt, v, u, rate));
    total = full - cheapest.reduce((s, u) => s + each(u), 0);
    const extra = Math.min(100, Math.max(0, Number(bar.xp) || 0));
    if (extra) total -= (total * extra) / 100;
  } else if (bar.dt === "percentage") {
    total = full * (1 - Math.min(v, 100) / 100);
  } else if (bar.dt === "amount") {
    total = units.reduce((s, u) => s + Math.max(0, u - amountEach(v, rate)), 0);
  } else if (bar.dt === "fixed_total") {
    total = Math.min(full, v * 100 * rate);
  }
  total = Math.round(total);
  const saved = Math.max(0, full - total);
  return { total, full, saved, savedPct: full > 0 ? Math.round((saved / full) * 100) : 0 };
}
