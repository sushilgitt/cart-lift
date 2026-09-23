import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigate } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { embedDeepLink, embedStatus } from "../lib/theme.server";
import { last30 } from "../lib/analytics.server";
import { change } from "../../packages/core/src";
import { formatChange } from "../lib/metric-defs";
import { monthlyUsage } from "../lib/billing.server";
import { planById } from "../lib/plans";
import { formatMoney } from "../lib/deals";
import { useT } from "../lib/admin-i18n";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUniqueOrThrow({
    where: { domain: session.shop },
    include: { _count: { select: { deals: true } } },
  });
  const activeDeals = await prisma.deal.count({ where: { shopId: shop.id, status: "ACTIVE" } });
  const embed = await embedStatus(admin);
  const { total, metrics, prevMetrics } = await last30(session.shop, shop.timezone);
  const usage = await monthlyUsage(shop.id);
  const plan = planById(shop.plan);

  return {
    shopDomain: session.shop,
    embedUrl: embedDeepLink(session.shop, process.env.SHOPIFY_API_KEY || ""),
    embedEnabled: embed.enabled,
    themeName: embed.themeName ?? null,
    dealCount: shop._count.deals,
    activeDeals,
    total,
    rates: metrics,
    // Change vs the 30 days before, per tile.
    changes: {
      revenue: formatChange(change(metrics.revenue, prevMetrics.revenue)),
      addedRevenue: formatChange(change(metrics.addedRevenue, prevMetrics.addedRevenue)),
      orders: formatChange(change(metrics.bundleOrders, prevMetrics.bundleOrders)),
      views: formatChange(change(metrics.visitors, prevMetrics.visitors)),
      conversion: formatChange(change(metrics.conversion, prevMetrics.conversion)),
      aov: formatChange(change(metrics.aov, prevMetrics.aov)),
    },
    moneyFormat: (shop.moneyFormat || "${{amount}}").replace(/<[^>]*>/g, ""),
    usage,
    plan: { name: plan.name, limit: plan.limit },
  };
};

export default function Dashboard() {
  const t = useT();
  const d = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const money = (n: number) => formatMoney(Math.round(n * 100), d.moneyFormat);
  const steps = [d.embedEnabled === true, d.dealCount > 0, d.activeDeals > 0];
  const done = steps.filter(Boolean).length;
  const usagePct = Math.min(100, Math.round((d.usage / d.plan.limit) * 100));

  return (
    <s-page heading={t("CartLift")}>
      <s-button slot="primary-action" variant="primary" onClick={() => navigate("/app/deals/new?template=quantity_breaks")}>
        {t("Create deal")}
      </s-button>

      {done < steps.length ? (
        <s-section heading={`Get started (${done} of ${steps.length})`}>
          <s-stack gap="base">
            <SetupStep
              done={steps[0]}
              title="Turn on the CartLift app embed"
              body={
                d.embedEnabled === null
                  ? "We couldn't read your theme settings. Open the theme editor and make sure CartLift deals is switched on under App embeds."
                  : `CartLift shows deals through an app embed in ${d.themeName ?? "your theme"}. It's one click and you can turn it off at any time.`
              }
              action={
                <s-button href={d.embedUrl} target="_blank" variant={steps[0] ? "tertiary" : "primary"}>
                  {steps[0] ? t("Open theme editor") : t("Turn on app embed")}
                </s-button>
              }
            />
            <SetupStep
              done={steps[1]}
              title="Create your first deal"
              body="Start from a template: quantity breaks, buy X get Y, or mix & match."
              action={<s-button onClick={() => navigate("/app/deals")}>{t("Choose a template")}</s-button>}
            />
            <SetupStep
              done={steps[2]}
              title="Activate a deal"
              body="Active deals show on matching product pages and are priced automatically at checkout."
              action={<s-button onClick={() => navigate("/app/deals")}>{t("Go to deals")}</s-button>}
            />
          </s-stack>
        </s-section>
      ) : null}

      <s-section heading={t("Last 30 days")}>
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(160px, 1fr))" gap="base">
          <Stat label={t("Deal revenue")} value={money(d.total.revenue)} hint={`${d.changes.revenue} vs previous 30 days`} />
          <Stat label={t("Added revenue")} value={money(d.total.addedRevenue)} hint={`${d.changes.addedRevenue} · paid beyond a single unit`} />
          <Stat label={t("Deal orders")} value={String(d.total.orders)} hint={`${d.changes.orders} vs previous 30 days`} />
          <Stat label={t("Visitors who saw a deal")} value={String(d.total.views)} hint={`${d.changes.views} vs previous 30 days`} />
          <Stat label={t("Conversion rate")} value={`${(d.rates.conversion * 100).toFixed(1)}%`} hint={`${d.changes.conversion} vs previous 30 days`} />
          <Stat label={t("Average order value")} value={money(d.rates.aov)} hint={`${d.changes.aov} vs previous 30 days`} />
          <Stat label={t("Units per order")} value={d.rates.unitsPerOrder.toFixed(2)} />
        </s-grid>
      </s-section>

      <s-section slot="aside" heading={t("Plan usage")}>
        <s-stack gap="small-200">
          <s-text>
            {d.plan.name} plan: {money(d.usage)} of {money(d.plan.limit)} added revenue this month
          </s-text>
          <div style={{ height: 8, borderRadius: 4, background: "#e3e3e3", overflow: "hidden" }}>
            <div style={{ width: `${usagePct}%`, height: "100%", background: usagePct >= 100 ? "#c70a24" : "#303030" }} />
          </div>
          {usagePct >= 80 ? (
            <s-paragraph>
              {usagePct >= 100 ? t("You've passed your plan's limit.") : t("You're close to your plan's limit.")} Your deals keep running.{" "}
              <s-link href="/app/plans">{t("See plans")}</s-link>
            </s-paragraph>
          ) : null}
        </s-stack>
      </s-section>

      <s-section slot="aside" heading={t("Tips")}>
        <s-unordered-list>
          <s-list-item>{t("Mark your middle bar as “Most popular” — shoppers anchor on it.")}</s-list-item>
          <s-list-item>{t("Add a free gift to your top bar to lift average order value.")}</s-list-item>
          <s-list-item>Add ?cartlift=off to a product URL to see the page without CartLift.</s-list-item>
        </s-unordered-list>
      </s-section>
    </s-page>
  );
}

function SetupStep({ done, title, body, action }: { done: boolean; title: string; body: string; action: React.ReactNode }) {
  return (
    <s-box padding="base" border="base" borderRadius="base">
      <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
        <s-stack gap="small-100">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-icon type={done ? "check-circle" : "circle"} tone={done ? "success" : "neutral"} />
            <s-heading>{title}</s-heading>
          </s-stack>
          <s-paragraph color="subdued">{body}</s-paragraph>
        </s-stack>
        {action}
      </s-stack>
    </s-box>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <s-box padding="base" border="base" borderRadius="base">
      <s-stack gap="small-100">
        <s-text color="subdued">{label}</s-text>
        <s-heading>{value}</s-heading>
        {hint ? <s-text color="subdued">{hint}</s-text> : null}
      </s-stack>
    </s-box>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
