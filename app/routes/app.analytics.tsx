import { useMemo } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigate, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { analytics, parseRange, PRESETS } from "../lib/analytics.server";
import { change, metrics } from "../../packages/core/src";
import { formatMoney } from "../lib/deals";
import { gql } from "../lib/shop.server";
import { DEFAULT_COLUMNS, METRICS, TILE_METRICS, formatChange, formatMetric, type MetricKey } from "../lib/metric-defs";
import { TrendChart } from "../components/TrendChart";

const FEATURE_LABELS: Record<string, string> = {
  gift: "Free gifts",
  upsell: "Upsells",
  bundle: "Complete the bundle",
  mix: "Mix & match",
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const shop = await prisma.shop.findUniqueOrThrow({
    where: { domain: session.shop },
    select: { moneyFormat: true, timezone: true },
  });
  const { range, previous, preset, fromInput, toInput } = parseRange(url.searchParams, shop.timezone);
  const dealId = url.searchParams.get("deal") || null;
  const data = await analytics(session.shop, range, previous, dealId);

  // Product names for the Products table.
  const productIds = [...new Set(data.products.map((p) => p.key))].slice(0, 50);
  const titles: Record<string, string> = {};
  if (productIds.length) {
    try {
      const res = await gql<{ nodes: ({ id: string; title: string } | null)[] }>(
        admin,
        `#graphql
          query cartliftProductTitles($ids: [ID!]!) { nodes(ids: $ids) { ... on Product { id title } } }`,
        { ids: productIds.map((id) => `gid://shopify/Product/${id}`) },
      );
      for (const n of res.nodes) if (n?.id) titles[n.id.split("/").pop()!] = n.title;
    } catch (error) {
      console.error("Product titles failed", error);
    }
  }

  const armsPerDeal = new Map<string, Set<string>>();
  for (const b of data.bundles) armsPerDeal.set(b.dealId, (armsPerDeal.get(b.dealId) ?? new Set()).add(b.arm));
  const dealOrders = (id: string) => data.bundles.filter((b) => b.dealId === id).reduce((s, b) => s + b.totals.orders, 0);

  return {
    preset,
    fromInput,
    toInput,
    dealId,
    days: range.days,
    moneyFormat: (shop.moneyFormat || "${{amount}}").replace(/<[^>]*>/g, ""),
    metrics: metrics(data.total),
    prevMetrics: metrics(data.prevTotal),
    series: data.series.map((s) => ({ day: s.day, prevDay: s.prevDay, cur: metrics(s.cur), prev: metrics(s.prev) })),
    bundles: data.bundles
      .map((b) => ({ ...b, metrics: metrics(b.totals), abTest: (armsPerDeal.get(b.dealId)?.size ?? 0) > 1 }))
      .sort((a, b) => b.totals.revenue - a.totals.revenue),
    bars: data.bars
      .map((b) => ({ ...b, share: dealOrders(b.dealId) ? b.totals.orders / dealOrders(b.dealId) : 0 }))
      .sort((a, b) => a.dealName.localeCompare(b.dealName) || b.totals.orders - a.totals.orders),
    products: data.products
      .map((p) => ({ ...p, title: titles[p.key] ?? `Product ${p.key}`, profit: p.totals.cost ? p.totals.revenue - p.totals.cost : null }))
      .sort((a, b) => b.totals.revenue - a.totals.revenue),
    features: data.features.map((f) => ({ ...f, label: FEATURE_LABELS[f.key] ?? f.key })),
    totalOrders: data.total.orders,
    deals: data.deals,
  };
};

/** App Bridge adds the session token to same-origin fetches, so download via fetch. */
async function exportCsv(query: string) {
  const response = await fetch(`/app/analytics/export?${query}`);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `cartlift-analytics.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function Analytics() {
  const d = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const money = (n: number) => formatMoney(Math.round(n * 100), d.moneyFormat);
  const fmt = (key: MetricKey, v: number | null) => formatMetric(METRICS.find((m) => m.key === key)!.kind, v, money);
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

  const chartMetric = (METRICS.find((m) => m.key === params.get("metric"))?.key ?? "revenue") as MetricKey;
  const columns = (params.get("cols")?.split(",").filter((c) => METRICS.some((m) => m.key === c)) as MetricKey[]) || DEFAULT_COLUMNS;
  const cols = columns.length ? columns : DEFAULT_COLUMNS;

  const go = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) {
      if (v == null || v === "") next.delete(k);
      else next.set(k, v);
    }
    navigate(`/app/analytics?${next.toString()}`);
  };

  const points = useMemo(
    () => d.series.map((s) => ({ day: s.day, prevDay: s.prevDay, value: Number(s.cur[chartMetric] ?? 0), prev: Number(s.prev[chartMetric] ?? 0) })),
    [d.series, chartMetric],
  );
  const chartDef = METRICS.find((m) => m.key === chartMetric)!;

  return (
    <s-page heading="Analytics">
      <s-button slot="secondary-actions" onClick={() => exportCsv(params.toString())}>
        Export CSV
      </s-button>

      {/* Filters: one row above everything */}
      <s-section>
        <s-stack direction="inline" gap="base" alignItems="end">
          <s-button-group>
            {PRESETS.map((n) => (
              <s-button key={n} variant={d.preset === n ? "primary" : "secondary"} onClick={() => go({ days: String(n), from: null, to: null })}>
                Last {n} days
              </s-button>
            ))}
          </s-button-group>
          <form
            style={{ display: "flex", gap: 8, alignItems: "end" }}
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              go({ from: String(f.get("from")), to: String(f.get("to")), days: null });
            }}
          >
            <label style={{ display: "grid", fontSize: 12, gap: 2 }}>
              From
              <input type="date" name="from" defaultValue={d.fromInput} key={`f${d.fromInput}`} />
            </label>
            <label style={{ display: "grid", fontSize: 12, gap: 2 }}>
              To
              <input type="date" name="to" defaultValue={d.toInput} key={`t${d.toInput}`} />
            </label>
            <s-button type="submit" variant={d.preset ? "secondary" : "primary"}>
              Apply
            </s-button>
          </form>
          <label style={{ display: "grid", fontSize: 12, gap: 2 }}>
            Deal
            <select value={d.dealId ?? ""} onChange={(e) => go({ deal: e.currentTarget.value || null })}>
              <option value="">All deals</option>
              {d.deals.map((deal) => (
                <option key={deal.id} value={deal.id}>
                  {deal.name}
                </option>
              ))}
            </select>
          </label>
        </s-stack>
      </s-section>

      <s-section heading={`Overview — ${d.days} days vs the ${d.days} before`}>
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(170px, 1fr))" gap="base">
          {TILE_METRICS.map((key) => {
            const def = METRICS.find((m) => m.key === key)!;
            const now = d.metrics[key];
            const before = d.prevMetrics[key];
            return (
              <s-box key={key} padding="base" border="base" borderRadius="base">
                <s-stack gap="small-100">
                  <s-text color="subdued">{def.label}</s-text>
                  <s-heading>{fmt(key, now)}</s-heading>
                  <s-text color="subdued">
                    {now == null || before == null ? "—" : formatChange(change(now, before))} vs previous
                  </s-text>
                </s-stack>
              </s-box>
            );
          })}
        </s-grid>
      </s-section>

      <s-section heading={`${chartDef.label} over time`}>
        <s-stack gap="base">
          <label style={{ display: "grid", fontSize: 12, gap: 2, maxWidth: 260 }}>
            Metric
            <select value={chartMetric} onChange={(e) => go({ metric: e.currentTarget.value })}>
              {METRICS.map((m) => (
                <option key={m.key} value={m.key}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <TrendChart title={chartDef.label} points={points} format={(n) => formatMetric(chartDef.kind, n, money)} />
        </s-stack>
      </s-section>

      <s-section heading="Bundles" padding="none">
        <s-box padding="base">
          <details>
            <summary style={{ cursor: "pointer" }}>Columns ({cols.length})</summary>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 16px", marginTop: 8 }}>
              {METRICS.map((m) => (
                <label key={m.key} style={{ fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={cols.includes(m.key)}
                    onChange={(e) => {
                      const next = e.currentTarget.checked ? [...cols, m.key] : cols.filter((c) => c !== m.key);
                      go({ cols: next.join(",") });
                    }}
                  />{" "}
                  {m.label}
                </label>
              ))}
            </div>
          </details>
        </s-box>
        {d.bundles.length === 0 ? (
          <s-box padding="base">
            <s-paragraph>No data yet. Stats appear once shoppers see your deals.</s-paragraph>
          </s-box>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Deal</s-table-header>
              <s-table-header>Variant</s-table-header>
              {cols.map((c) => (
                <s-table-header key={c} format="numeric">
                  {METRICS.find((m) => m.key === c)!.label}
                </s-table-header>
              ))}
            </s-table-header-row>
            <s-table-body>
              {d.bundles.map((r) => (
                <s-table-row key={`${r.dealId}-${r.arm}`}>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small-200" alignItems="center">
                      <s-link href={`/app/deals/${r.dealId}`}>{r.name}</s-link>
                      {r.abTest ? <s-badge tone="info">A/B</s-badge> : null}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>{r.arm}</s-table-cell>
                  {cols.map((c) => (
                    <s-table-cell key={c}>{fmt(c, r.metrics[c])}</s-table-cell>
                  ))}
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section heading="Bars" padding="none">
        {d.bars.length === 0 ? (
          <s-box padding="base">
            <s-paragraph color="subdued">Bar results appear with new orders.</s-paragraph>
          </s-box>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Bar</s-table-header>
              <s-table-header>Deal</s-table-header>
              <s-table-header format="numeric">Add to carts</s-table-header>
              <s-table-header format="numeric">Orders</s-table-header>
              <s-table-header format="numeric">Share of deal orders</s-table-header>
              <s-table-header format="numeric">Units</s-table-header>
              <s-table-header format="numeric">Revenue</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {d.bars.map((b) => (
                <s-table-row key={`${b.dealId}-${b.arm}-${b.key}`}>
                  <s-table-cell>{b.title}</s-table-cell>
                  <s-table-cell>
                    {b.dealName}
                    {b.arm !== "A" ? ` (${b.arm})` : ""}
                  </s-table-cell>
                  <s-table-cell>{b.totals.addToCarts}</s-table-cell>
                  <s-table-cell>{b.totals.orders}</s-table-cell>
                  <s-table-cell>{pct(b.share)}</s-table-cell>
                  <s-table-cell>{b.totals.units}</s-table-cell>
                  <s-table-cell>{money(b.totals.revenue)}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section heading="Products" padding="none">
        {d.products.length === 0 ? (
          <s-box padding="base">
            <s-paragraph color="subdued">Product results appear as shoppers view and buy deals.</s-paragraph>
          </s-box>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Product</s-table-header>
              <s-table-header format="numeric">Views</s-table-header>
              <s-table-header format="numeric">Add to carts</s-table-header>
              <s-table-header format="numeric">Orders</s-table-header>
              <s-table-header format="numeric">Units</s-table-header>
              <s-table-header format="numeric">Revenue</s-table-header>
              <s-table-header format="numeric">Profit</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {d.products.map((p) => (
                <s-table-row key={p.key}>
                  <s-table-cell>{p.title}</s-table-cell>
                  <s-table-cell>{p.totals.views}</s-table-cell>
                  <s-table-cell>{p.totals.addToCarts}</s-table-cell>
                  <s-table-cell>{p.totals.orders}</s-table-cell>
                  <s-table-cell>{p.totals.units}</s-table-cell>
                  <s-table-cell>{money(p.totals.revenue)}</s-table-cell>
                  <s-table-cell>{p.profit == null ? "—" : money(p.profit)}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section heading="Features" padding="none">
        {d.features.length === 0 ? (
          <s-box padding="base">
            <s-paragraph color="subdued">Gifts, upsells, bundles and mix & match show here once they sell.</s-paragraph>
          </s-box>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Feature</s-table-header>
              <s-table-header format="numeric">Orders</s-table-header>
              <s-table-header format="numeric">Share of bundle orders</s-table-header>
              <s-table-header format="numeric">Units</s-table-header>
              <s-table-header format="numeric">Revenue</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {d.features.map((f) => (
                <s-table-row key={f.key}>
                  <s-table-cell>{f.label}</s-table-cell>
                  <s-table-cell>{f.totals.orders}</s-table-cell>
                  <s-table-cell>{d.totalOrders ? pct(f.totals.orders / d.totalOrders) : "—"}</s-table-cell>
                  <s-table-cell>{f.totals.units}</s-table-cell>
                  <s-table-cell>{money(f.totals.revenue)}</s-table-cell>
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
