import { register, type Checkout } from "@shopify/web-pixels-extension";

/**
 * Attributes checkouts to CartLift deals.
 *
 * The widget tags deal lines with `_cartlift` (deal id) and `_cartlift_arm`;
 * complete-the-bundle lines with `_cartlift_bundle` (`dealId:barId`), the
 * viewed product among them with `_cartlift_main`.
 *  - checkout_started: which deals the checkout contains (checkout rate).
 *  - checkout_completed: for each deal, units, revenue after line discounts,
 *    and "added revenue" — what the shopper paid beyond a single unit, the
 *    number Kaching reports and bills on.
 */
register(({ analytics, settings }) => {
  const shop = String(settings.shop || "");
  const api = String(settings.api || "");
  if (!shop || !api) return;

  type Agg = { d: string; a: string; units: number; revenue: number; single: Record<string, number> };

  /** Per-deal totals of the checkout's CartLift lines. */
  function dealsIn(checkout: Checkout): Agg[] {
    const deals: Record<string, Agg> = {};
    for (const line of checkout.lineItems || []) {
      const props: Record<string, string> = {};
      for (const p of line.properties || []) props[p.key] = p.value;
      const dealId =
        props._cartlift ||
        (props._cartlift_bundle ?? "").split(":")[0] ||
        (props._cartlift_gift ?? "") ||
        (props._cartlift_upsell ?? "").split(":")[0];
      if (!dealId) continue;

      const agg = (deals[dealId] ||= { d: dealId, a: props._cartlift_arm || "A", units: 0, revenue: 0, single: {} });
      agg.revenue += Number(line.finalLinePrice?.amount ?? 0);
      if (props._cartlift || props._cartlift_bundle) {
        agg.units += line.quantity;
        // Added revenue is what was paid beyond one unit of each deal product;
        // for a bundle, beyond one unit of the main product only.
        if (props._cartlift || props._cartlift_main) {
          const productId = line.variant?.product?.id || line.variant?.id || "x";
          const unit = Number(line.variant?.price?.amount ?? 0);
          agg.single[productId] = Math.max(agg.single[productId] || 0, unit);
        }
      }
    }
    return Object.values(deals);
  }

  function send(event: Record<string, unknown>) {
    fetch(api, {
      method: "POST",
      keepalive: true,
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ shop, events: [event] }),
    }).catch(() => {});
  }

  analytics.subscribe("checkout_started", (event) => {
    const checkout = event.data.checkout;
    if (!checkout.token) return;
    const deals = dealsIn(checkout).map((agg) => ({ d: agg.d, a: agg.a }));
    if (deals.length) send({ t: "checkout", o: checkout.token, deals });
  });

  analytics.subscribe("checkout_completed", (event) => {
    const checkout = event.data.checkout;
    const orderId = checkout.order?.id || checkout.token;
    if (!orderId) return;

    const deals = dealsIn(checkout).map((agg) => {
      const single = Object.values(agg.single).reduce((s, v) => s + v, 0);
      return {
        d: agg.d,
        a: agg.a,
        units: agg.units,
        revenue: Math.round(agg.revenue * 100) / 100,
        added: Math.max(0, Math.round((agg.revenue - single) * 100) / 100),
      };
    });
    if (deals.length) send({ t: "order", o: String(orderId), cur: checkout.currencyCode, deals });
  });
});
