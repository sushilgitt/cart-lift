import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { PLANS } from "../lib/plans";
import { monthlyUsage, pricingPageUrl } from "../lib/billing.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUniqueOrThrow({ where: { domain: session.shop } });
  return {
    current: shop.plan,
    usage: await monthlyUsage(shop.id),
    pricingUrl: pricingPageUrl(session.shop),
  };
};

export default function Plans() {
  const d = useLoaderData<typeof loader>();
  return (
    <s-page heading="Plans">
      <s-section>
        <s-paragraph>
          Plans are based on <strong>added revenue</strong>: what shoppers paid beyond a single unit on CartLift deals.
          This month so far: <strong>${d.usage.toFixed(2)}</strong>. Going over never switches your deals off.
        </s-paragraph>
      </s-section>
      <s-grid gridTemplateColumns="repeat(auto-fit, minmax(200px, 1fr))" gap="base">
        {PLANS.map((plan) => (
          <s-section key={plan.id} heading={plan.name}>
            <s-stack gap="base">
              <s-heading>{plan.price ? `$${plan.price}/month` : "Free"}</s-heading>
              <s-unordered-list>
                {plan.features.map((f) => (
                  <s-list-item key={f}>{f}</s-list-item>
                ))}
              </s-unordered-list>
              {plan.id === d.current ? (
                <s-badge tone="success">Current plan</s-badge>
              ) : (
                <s-button href={d.pricingUrl} target="_top">
                  Choose {plan.name}
                </s-button>
              )}
            </s-stack>
          </s-section>
        ))}
      </s-grid>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
