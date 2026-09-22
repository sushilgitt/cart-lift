/** Formats cents with a Shopify money format such as `${{amount}}` or `{{amount_with_comma_separator}} €`. */
export function formatMoney(cents: number, format = "${{amount}}"): string {
  const amount = (Math.round(cents) / 100).toFixed(2);
  const [whole, dec] = amount.split(".");
  // No-decimals formats round to the whole unit, as Shopify does (1,234.56 → 1,235).
  const rounded = String(Math.round(Math.round(cents) / 100));
  const group = (sep: string, digits = whole) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
  return format.replace(/\{\{\s*(\w+)\s*\}\}/, (_m, key: string) => {
    switch (key) {
      case "amount_no_decimals":
        return group(",", rounded);
      case "amount_with_comma_separator":
        return `${group(".")},${dec}`;
      case "amount_no_decimals_with_comma_separator":
        return group(".", rounded);
      case "amount_with_apostrophe_separator":
        return `${group("'")}.${dec}`;
      default:
        return `${group(",")}.${dec}`;
    }
  });
}

/** A decimal money amount (e.g. "12.50") in shop currency → presentment cents. */
export function moneyToCents(value: unknown, rate = 1): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100 * rate) : 0;
}
