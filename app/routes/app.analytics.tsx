import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigate } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { dealAnalytics, rangeFromParam, rates } from "../lib/analytics.server";
import { formatMoney } from "../lib/deals";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const { days, from, to } = rangeFromParam(url.searchParams.get("days"));
  const shop = await prisma.shop.findUniqueOrThrow({ where: { domain: session.shop }, select: { moneyFormat: true } });
  const data = await dealAnalytics(session.shop, from, to);
  return {
    days,
    moneyFormat: (shop.moneyFormat || "${{amount}}").replace(/<[^>]*>/g, ""),
    total: data.total,
    totalRates: rates(data.total),
    rows: data.rows.map((r) => ({ ...r, rates: rates(r) })),
    series: data.series,
  };
};

/** App Bridge adds the session token to same-origin fetches, so download via fetch. */
async function exportCsv(days: number) {
  const response = await fetch(`/app/analytics/export?days=${days}`);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `cartlift-analytics-${days}d.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function Analytics() {
  const d = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const money = (n: number) => formatMoney(Math.round(n * 100), d.moneyFormat);
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const max = Math.max(1, ...d.series.map((s) => s.revenue));

  return (
    <s-page heading="Analytics">
      <s-button slot="secondary-actions" onClick={() => exportCsv(d.days)}>
        Export CSV
      </s-button>

      <s-section>
        <s-stack direction="inline" gap="small-200">
          {[7, 30, 90].map((n) => (
            <s-button key={n} variant={n === d.days ? "primary" : "secondary"} onClick={() => navigate(`/app/analytics?days=${n}`)}>
              Last {n} days
            </s-button>
          ))}
        </s-stack>
      </s-section>

      <s-section heading="Overview">
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(150px, 1fr))" gap="base">
          {[
            ["Revenue", money(d.total.revenue)],
            ["Added revenue", money(d.total.addedRevenue)],
            ["Orders", String(d.total.orders)],
            ["Visitors", String(d.total.views)],
            ["Add-to-cart rate", pct(d.totalRates.atcRate)],
            ["Checkout rate", pct(d.totalRates.checkoutRate)],
            ["Conversion", pct(d.totalRates.conversion)],
            ["AOV", money(d.totalRates.aov)],
            ["Units per order", d.totalRates.unitsPerOrder.toFixed(2)],
            ["Revenue / visitor", money(d.totalRates.revenuePerVisitor)],
          ].map(([label, value]) => (
            <s-box key={label} padding="base" border="base" borderRadius="base">
              <s-text color="subdued">{label}</s-text>
              <s-heading>{value}</s-heading>
            </s-box>
          ))}
        </s-grid>
      </s-section>

      <s-section heading="Deal revenue per day">
        <div
          role="img"
          aria-label={`Revenue per day over the last ${d.days} days`}
          style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 140 }}
        >
          {d.series.map((s) => (
            <div
              key={s.day}
              title={`${s.day}: ${money(s.revenue)} · ${s.orders} orders`}
              style={{
                flex: 1,
                minWidth: 2,
                height: `${Math.max(2, (s.revenue / max) * 100)}%`,
                background: s.revenue ? "#303030" : "#e3e3e3",
                borderRadius: "3px 3px 0 0",
              }}
            />
          ))}
        </div>
      </s-section>

      <s-section heading="By deal" padding="none">
        {d.rows.length === 0 ? (
          <s-box padding="base">
            <s-paragraph>No data yet. Stats appear once shoppers see your deals.</s-paragraph>
          </s-box>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Deal</s-table-header>
              <s-table-header>Variant</s-table-header>
              <s-table-header format="numeric">Visitors</s-table-header>
              <s-table-header format="numeric">Add to cart</s-table-header>
              <s-table-header format="numeric">Checkouts</s-table-header>
              <s-table-header format="numeric">Orders</s-table-header>
              <s-table-header format="numeric">Conversion</s-table-header>
              <s-table-header format="numeric">Revenue</s-table-header>
              <s-table-header format="numeric">Added revenue</s-table-header>
              <s-table-header format="numeric">AOV</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {d.rows.map((r) => (
                <s-table-row key={`${r.dealId}-${r.arm}`}>
                  <s-table-cell>
                    <s-link href={`/app/deals/${r.dealId}`}>{r.name}</s-link>
                  </s-table-cell>
                  <s-table-cell>{r.arm}</s-table-cell>
                  <s-table-cell>{r.views}</s-table-cell>
                  <s-table-cell>{r.addToCarts}</s-table-cell>
                  <s-table-cell>{r.checkouts}</s-table-cell>
                  <s-table-cell>{r.orders}</s-table-cell>
                  <s-table-cell>{pct(r.rates.conversion)}</s-table-cell>
                  <s-table-cell>{money(r.revenue)}</s-table-cell>
                  <s-table-cell>{money(r.addedRevenue)}</s-table-cell>
                  <s-table-cell>{money(r.rates.aov)}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
