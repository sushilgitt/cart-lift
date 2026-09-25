export type DiscountType = "none" | "percentage" | "amount" | "fixed_total";

/** The fields of a bar that decide its price, in storefront naming. */
export interface PricedBar {
  /** "bundle" bars are priced per item (priceBundle); here they price like "qty". */
  kind: "qty" | "bxgy" | "bundle";
  qty: number;
  /** BXGY: discounted units per set. */
  get?: number;
  dt: DiscountType;
  dv: number;
  /** BXGY: extra percentage off what is left after the free items. */
  xp?: number;
}

export interface BarPrice {
  /** What the shopper pays for the bar, in cents. */
  total: number;
  /** Price without the deal, in cents. */
  full: number;
  saved: number;
  savedPct: number;
  unit: number;
}

/**
 * "Amount off each item" in presentment cents. The Function sends Shopify one
 * converted amount applied to every item, so it is rounded once, per unit —
 * rounding only the bar total would show a cent more or less than checkout
 * charges whenever the currency rate isn't 1.
 */
export const amountEach = (dv: number, rate = 1) => Math.round(Math.max(0, Number(dv) || 0) * 100 * rate);

/**
 * Prices a bar for a unit price in cents, as checkout will (the Discount
 * Function applies the same rules). `compare` is the compare-at unit price in
 * cents (0 = none); `rate` converts shop-currency amounts to presentment.
 */
export function priceBar(bar: PricedBar, unit: number, compare = 0, rate = 1): BarPrice {
  const qty = Math.max(1, bar.qty);
  const base = unit * qty;
  const v = Math.max(0, Number(bar.dv) || 0);
  let total = base;

  if (bar.kind === "bxgy") {
    const get = Math.min(bar.get || 0, qty - 1);
    let each: number;
    if (bar.dt === "none") each = unit;
    else if (bar.dt === "percentage") each = (unit * Math.min(v, 100)) / 100;
    else if (bar.dt === "amount") each = Math.min(v * 100 * rate, unit);
    else each = Math.max(0, unit - v * 100 * rate);
    total = base - each * Math.max(0, get);
    const extra = Math.min(100, Math.max(0, Number(bar.xp) || 0));
    if (extra) total -= (total * extra) / 100;
  } else if (bar.dt === "percentage") {
    total = base * (1 - Math.min(v, 100) / 100);
  } else if (bar.dt === "amount") {
    total = Math.max(0, base - Math.min(amountEach(v, rate), unit) * qty);
  } else if (bar.dt === "fixed_total") {
    total = Math.min(base, v * 100 * rate);
  }

  total = Math.round(total);
  const full = Math.max(base, compare > unit ? compare * qty : base);
  const saved = Math.max(0, full - total);
  return {
    total,
    full,
    saved,
    savedPct: full > 0 ? Math.round((saved / full) * 100) : 0,
    unit: Math.round(total / qty),
  };
}
