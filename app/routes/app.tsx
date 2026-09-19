import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";
import { backfillShopProfile, ensureShop } from "../lib/shop.server";
import { ensureWebPixel } from "../lib/pixel.server";
import { syncPlanFromShopify } from "../lib/billing.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  // No "installed" webhook exists, so provisioning happens on first load.
  const shop = await ensureShop(session.shop);
  if (!shop.currencyCode) await backfillShopProfile(admin, session.shop);
  await ensureWebPixel(admin, session.shop);
  await syncPlanFromShopify(admin, session.shop);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Dashboard</s-link>
        <s-link href="/app/deals">Deals</s-link>
        <s-link href="/app/analytics">Analytics</s-link>
        <s-link href="/app/settings">Settings</s-link>
        <s-link href="/app/plans">Plans</s-link>
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
