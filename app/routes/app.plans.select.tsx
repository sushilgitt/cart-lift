import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { appHandle, pricingPageUrl } from "../lib/billing.server";

/**
 * GET /app/plans/select → Shopify's hosted plan page (managed pricing).
 *
 * The pricing page is Shopify admin UI and won't render inside the embedded
 * iframe, so the redirect targets the top window. Shopify sends the merchant
 * back to the app afterwards, where app.tsx re-reads the subscription.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session, redirect } = await authenticate.admin(request);
  const handle = await appHandle(admin);
  return redirect(pricingPageUrl(session.shop, handle), { target: "_top" });
};
