import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useState } from "react";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ANNUAL_DISCOUNT, PLANS, TRIAL_DAYS, planById, planFrom } from "../lib/plans";
import { appHandle, monthlyUsage, syncPlanFromShopify } from "../lib/billing.server";
import { PlanButton } from "../components/PlanButton";
import { Select } from "../components/fields";
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
    // Development stores are free: no charge, and no nagging about limits.
    devStore: shop.devStore,
    moneyFormat: (shop.moneyFormat || "${{amount}}").replace(/<[^>]*>/g, ""),
  };
};

export default function Plans() {
  const t = useT();
  const d = useLoaderData<typeof loader>();
  const current = planById(d.current);
  const money = (n: number) => formatMoney(Math.round(n * 100), d.moneyFormat);
  const pct = Math.min(100, Math.round((d.usage / current.limit) * 100));
  const [yearly, setYearly] = useState(false);
  // What the merchant's own numbers say they need, for the upgrade prompt.
  const suggested = d.usage > current.limit ? planFrom(d.usage) : null;

  return (
    <s-page heading={t("Plans")}>
      <PlanButton slot="primary-action" variant="primary" handle={d.handle}>
        {d.current === "FREE" ? t("Upgrade plan") : t("Change plan")}
      </PlanButton>

      <s-section heading={t("You're on {{plan}}", { plan: current.name })}>
        <s-stack gap="small-200">
          <s-paragraph>
            Plans are based on <strong>{t("added revenue")}</strong> — what shoppers paid beyond a single unit on CartLift
            deals. This month: <strong>{money(d.usage)}</strong> of {money(current.limit)}.
          </s-paragraph>
          {d.devStore ? (
            <s-banner tone="info">
              {t("This is a development store, so CartLift is free here and plan limits don't apply.")}
            </s-banner>
          ) : null}
          {suggested && suggested.id !== current.id ? (
            <s-banner tone="warning">
              {t("You're past your plan's limit. {{plan}} covers up to {{limit}} a month.", {
                plan: suggested.name,
                limit: money(suggested.limit),
              })}
            </s-banner>
          ) : null}
          <div style={{ height: 8, borderRadius: 4, background: "#e3e3e3", overflow: "hidden" }}>
            <div style={{ width: `${pct}%`, height: "100%", background: pct >= 100 ? "#c70a24" : "#303030" }} />
          </div>
          <s-paragraph color="subdued">
            {t("Going over your limit never switches your deals off. Billing, trials and invoices are handled by Shopify and appear on your Shopify bill.")}
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section>
        <s-stack direction="inline" gap="base" alignItems="center">
          <Select
            label={t("Billing period")}
            value={yearly ? "year" : "month"}
            onChange={(value) => setYearly(value === "year")}
            options={[
              { value: "month", label: t("Monthly") },
              { value: "year", label: t("Yearly (save {{percent}}%)", { percent: Math.round(ANNUAL_DISCOUNT * 100) }) },
            ]}
          />
          <s-badge tone="info">{t("{{days}}-day free trial on every paid plan", { days: TRIAL_DAYS })}</s-badge>
        </s-stack>
      </s-section>

      <s-grid gridTemplateColumns="repeat(auto-fit, minmax(200px, 1fr))" gap="base">
        {PLANS.map((plan) => (
          <s-section key={plan.id} heading={plan.name}>
            <s-stack gap="base">
              <s-heading>
                {!plan.price
                  ? t("Free")
                  : yearly
                    ? t("${{price}}/year", { price: plan.annualPrice })
                    : t("${{price}}/month", { price: plan.price })}
              </s-heading>
              {plan.price && yearly ? (
                <s-text color="subdued">{t("${{price}}/month, billed yearly", { price: (plan.annualPrice / 12).toFixed(2) })}</s-text>
              ) : null}
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
