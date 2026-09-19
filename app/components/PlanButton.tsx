import type { ReactNode } from "react";

/**
 * Opens Shopify's hosted plan page (managed pricing).
 *
 * `shopify://admin/...` with target `_top` is App Bridge's way to navigate the
 * Shopify admin itself rather than the app iframe. A server-side redirect
 * doesn't work here: inside the embedded app it comes back as a 401 that React
 * Router renders as an error page.
 */
export function openPricingPage(handle: string) {
  window.open(`shopify://admin/charges/${handle}/pricing_plans`, "_top");
}

export function PlanButton({
  handle,
  children,
  variant,
  slot,
}: {
  handle: string;
  children: ReactNode;
  variant?: "primary" | "secondary" | "tertiary";
  slot?: Lowercase<string>;
}) {
  return (
    <s-button slot={slot} variant={variant} onClick={() => openPricingPage(handle)}>
      {children}
    </s-button>
  );
}
