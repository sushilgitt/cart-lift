export type DiscountType = "none" | "percentage" | "amount" | "fixed_total";

/** The fields of a bar that decide its price, in storefront naming. */
export interface PricedBar {
  kind: "qty" | "bxgy";
  qty: number;
  /** BXGY: discounted units per set. */
  get?: number;
  dt: DiscountType;
  dv: number;
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
  } else if (bar.dt === "percentage") {
    total = base * (1 - Math.min(v, 100) / 100);
  } else if (bar.dt === "amount") {
    total = Math.max(0, base - v * 100 * rate * qty);
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
