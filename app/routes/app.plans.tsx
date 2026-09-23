import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { PLANS, planById } from "../lib/plans";
import { appHandle, monthlyUsage, syncPlanFromShopify } from "../lib/billing.server";
import { PlanButton } from "../components/PlanButton";
import { formatMoney } from "../lib/deals";
import { useT } from "../lib/admin-i18n";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  // Fresh read so a plan chosen a moment ago shows immediately.
  await syncPlanFromShopify(admin, session.shop);
  const shop = await prisma.shop.findUniqueOrThrow({ where: { domain: session.shop } });
  return {
    current: shop.plan,
    handle: await appHandle(admin),
    usage: await monthlyUsage(shop.id),
    moneyFormat: (shop.moneyFormat || "${{amount}}").replace(/<[^>]*>/g, ""),
  };
};

export default function Plans() {
  const t = useT();
  const d = useLoaderData<typeof loader>();
  const current = planById(d.current);
  const money = (n: number) => formatMoney(Math.round(n * 100), d.moneyFormat);
  const pct = Math.min(100, Math.round((d.usage / current.limit) * 100));

  return (
    <s-page heading={t("Plans")}>
      <PlanButton slot="primary-action" variant="primary" handle={d.handle}>
        {d.current === "FREE" ? t("Upgrade plan") : t("Change plan")}
      </PlanButton>

      <s-section heading={`You're on ${current.name}`}>
        <s-stack gap="small-200">
          <s-paragraph>
            Plans are based on <strong>{t("added revenue")}</strong> — what shoppers paid beyond a single unit on CartLift
            deals. This month: <strong>{money(d.usage)}</strong> of {money(current.limit)}.
          </s-paragraph>
          <div style={{ height: 8, borderRadius: 4, background: "#e3e3e3", overflow: "hidden" }}>
            <div style={{ width: `${pct}%`, height: "100%", background: pct >= 100 ? "#c70a24" : "#303030" }} />
          </div>
          <s-paragraph color="subdued">
            {t("Going over your limit never switches your deals off. Billing, trials and invoices are handled by Shopify and appear on your Shopify bill.")}
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-grid gridTemplateColumns="repeat(auto-fit, minmax(200px, 1fr))" gap="base">
        {PLANS.map((plan) => (
          <s-section key={plan.id} heading={plan.name}>
            <s-stack gap="base">
              <s-heading>{plan.price ? t("${{price}}/month", { price: plan.price }) : t("Free")}</s-heading>
              <s-stack gap="small-100">
                {plan.features.map((f) => (
                  <s-text key={f}>✓ {t(f)}</s-text>
                ))}
              </s-stack>
              {plan.id === d.current ? (
                <s-badge tone="success">{t("Current plan")}</s-badge>
              ) : (
                <PlanButton handle={d.handle}>{t("Choose {{plan}}", { plan: plan.name })}</PlanButton>
              )}
            </s-stack>
          </s-section>
        ))}
      </s-grid>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
