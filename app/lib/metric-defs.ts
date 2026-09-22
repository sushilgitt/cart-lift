import type { Metrics } from "../../packages/core/src";

/** Labels and formats for the analytics metrics (client-safe). */

/** Date-range presets, in days. */
export const PRESETS = [7, 30, 90] as const;

export type MetricKey = keyof Metrics;
export type MetricKind = "money" | "count" | "percent" | "decimal";

export const METRICS: { key: MetricKey; label: string; kind: MetricKind; help?: string }[] = [
  { key: "revenue", label: "Revenue", kind: "money", help: "Paid for deal lines, after discounts" },
  { key: "addedRevenue", label: "Added revenue", kind: "money", help: "Paid beyond a single unit" },
  { key: "bundleOrders", label: "Bundle orders", kind: "count" },
  { key: "visitors", label: "Visitors", kind: "count", help: "Saw a deal" },
  { key: "conversion", label: "Conversion rate", kind: "percent", help: "Bundle orders per visitor" },
  { key: "aov", label: "Average order value", kind: "money" },
  { key: "revenuePerVisitor", label: "Revenue per visitor", kind: "money" },
  { key: "profitPerVisitor", label: "Profit per visitor", kind: "money", help: "Needs product costs in Shopify" },
  { key: "profitability", label: "Profitability", kind: "percent", help: "Profit ÷ revenue; needs product costs" },
  { key: "addToCarts", label: "Add to carts", kind: "count" },
  { key: "atcRate", label: "Add-to-cart rate", kind: "percent" },
  { key: "checkoutRate", label: "Checkout rate", kind: "percent" },
  { key: "subscribed", label: "Subscribed orders", kind: "count" },
  { key: "subscriptionRate", label: "Subscription rate", kind: "percent" },
  { key: "unitsPerOrder", label: "Units per order", kind: "decimal" },
  { key: "visitorConversion", label: "Visitor conversion", kind: "percent", help: "Any order from a visitor who saw the deal" },
];

/** The 15 headline tiles (Kaching's Analytics 2.0 set). */
export const TILE_METRICS: MetricKey[] = METRICS.map((m) => m.key).filter((k) => k !== "visitorConversion");

export const DEFAULT_COLUMNS: MetricKey[] = ["visitors", "atcRate", "bundleOrders", "conversion", "revenue", "addedRevenue", "aov"];

export function formatMetric(kind: MetricKind, value: number | null, money: (n: number) => string): string {
  if (value == null) return "—";
  if (kind === "money") return money(value);
  if (kind === "percent") return `${(value * 100).toFixed(1)}%`;
  if (kind === "decimal") return value.toFixed(2);
  return Math.round(value).toLocaleString();
}

/** "+12.3%", "−4.0%" or "—": change is spelled out, never colour alone. */
export function formatChange(change: number | null): string {
  if (change == null || !Number.isFinite(change)) return "—";
  const pct = (change * 100).toFixed(1);
  return change > 0 ? `+${pct}%` : change < 0 ? `−${pct.replace("-", "")}%` : "0.0%";
}
