import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { rangeFromParam } from "../lib/analytics.server";

const csv = (v: unknown) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Daily rows per deal and variant as CSV. */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { from, to } = rangeFromParam(new URL(request.url).searchParams.get("days"));
  const shop = await prisma.shop.findUniqueOrThrow({ where: { domain: session.shop }, select: { currencyCode: true } });
  const rows = await prisma.dailyStat.findMany({
    where: { shop: { domain: session.shop }, day: { gte: from, lt: to } },
    include: { deal: { select: { name: true } } },
    orderBy: [{ day: "asc" }, { dealId: "asc" }],
  });

  const header = [
    "date", "deal_name", "variant", "currency", "visitors", "add_to_carts", "atc_rate_%",
    "orders", "conversion_%", "units", "revenue", "added_revenue", "aov", "revenue_per_visitor",
  ];
  const lines = rows.map((r) => {
    const revenue = Number(r.revenue);
    return [
      r.day.toISOString().slice(0, 10), r.deal.name, r.arm, shop.currencyCode ?? "",
      r.views, r.addToCarts, r.views ? ((r.addToCarts / r.views) * 100).toFixed(2) : "0",
      r.orders, r.views ? ((r.orders / r.views) * 100).toFixed(2) : "0", r.units,
      revenue.toFixed(2), Number(r.addedRevenue).toFixed(2),
      r.orders ? (revenue / r.orders).toFixed(2) : "0", r.views ? (revenue / r.views).toFixed(2) : "0",
    ].map(csv).join(",");
  });

  return new Response([header.join(","), ...lines].join("\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="cartlift-analytics.csv"`,
    },
  });
};
