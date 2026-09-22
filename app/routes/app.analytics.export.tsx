import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { parseRange } from "../lib/analytics.server";
import { emptyTotals, addTotals, metrics } from "../../packages/core/src";

const csv = (v: unknown) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const pct = (n: number) => (n * 100).toFixed(2);

/** The 17 daily columns of Kaching's analytics export, per deal and A/B variant. */
const HEADER = [
  "date", "deal_name", "variant", "currency", "visitors", "add_to_carts", "atc_rate_%",
  "eligible_orders", "bundle_orders", "visitor_conversion_%", "bundle_conversion_%",
  "subscribed_orders", "subscribed_rate_%", "total_revenue", "added_revenue", "aov", "revenue_per_visitor",
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const shop = await prisma.shop.findUniqueOrThrow({
    where: { domain: session.shop },
    select: { currencyCode: true, timezone: true },
  });
  const { range } = parseRange(url.searchParams, shop.timezone);
  const dealId = url.searchParams.get("deal") || undefined;
  const rows = await prisma.dailyStat.findMany({
    where: { shop: { domain: session.shop }, day: { gte: range.from, lt: range.to }, ...(dealId ? { dealId } : {}) },
    include: { deal: { select: { name: true } } },
    orderBy: [{ day: "asc" }, { dealId: "asc" }, { arm: "asc" }],
  });

  const lines = rows.map((r) => {
    const t = addTotals(emptyTotals(), r);
    const m = metrics(t);
    return [
      r.day.toISOString().slice(0, 10), r.deal.name, r.arm, shop.currencyCode ?? "",
      t.views, t.addToCarts, pct(m.atcRate),
      t.eligibleOrders, t.orders, pct(m.visitorConversion), pct(m.conversion),
      t.subscribedOrders, pct(m.subscriptionRate),
      t.revenue.toFixed(2), t.addedRevenue.toFixed(2), m.aov.toFixed(2), m.revenuePerVisitor.toFixed(2),
    ].map(csv).join(",");
  });

  return new Response([HEADER.join(","), ...lines].join("\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="cartlift-analytics.csv"`,
    },
  });
};
