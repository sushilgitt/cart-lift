import { useEffect, useState } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";
import { backfillShopProfile, ensureShop } from "../lib/shop.server";
import { ensureWebPixel } from "../lib/pixel.server";
import { syncPlanFromShopify } from "../lib/billing.server";
import { I18nProvider, adminLocale, matchLocale, useT } from "../lib/admin-i18n";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  // No "installed" webhook exists, so provisioning happens on first load.
  const shop = await ensureShop(session.shop);
  if (!shop.currencyCode || !shop.timezone) await backfillShopProfile(admin, session.shop);
  await ensureWebPixel(admin, session.shop);
  await syncPlanFromShopify(admin, session.shop);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "", locale: adminLocale(request) };
};

export default function App() {
  const { apiKey, locale } = useLoaderData<typeof loader>();
  // Shopify's `?locale=` is only on the first URL; navigating inside the app
  // drops it, so the language is kept here and confirmed by App Bridge, which
  // knows the staff member's own language.
  const [language, setLanguage] = useState(locale);
  useEffect(() => {
    const own = (window as { shopify?: { config?: { locale?: string } } }).shopify?.config?.locale;
    const next = own ? matchLocale(own) : locale;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (next !== "en" && next !== language) setLanguage(next);
  }, [locale, language]);

  return (
    <AppProvider embedded apiKey={apiKey}>
      <I18nProvider locale={language}>
        <Nav />
        <Outlet />
      </I18nProvider>
    </AppProvider>
  );
}

function Nav() {
  const t = useT();
  return (
    <s-app-nav>
      <s-link href="/app">{t("Dashboard")}</s-link>
      <s-link href="/app/deals">{t("Deals")}</s-link>
      <s-link href="/app/analytics">{t("Analytics")}</s-link>
      <s-link href="/app/settings">{t("Settings")}</s-link>
      <s-link href="/app/plans">{t("Plans")}</s-link>
    </s-app-nav>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
