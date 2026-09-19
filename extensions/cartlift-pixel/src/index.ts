import { register } from "@shopify/web-pixels-extension";

/**
 * Attributes completed checkouts to CartLift deals.
 *
 * The widget tags deal lines with `_cartlift` (deal id) and `_cartlift_arm`.
 * For each deal we report units, revenue after line discounts, and "added
 * revenue" — what the shopper paid beyond a single unit, the number Kaching
 * reports and bills on.
 */
register(({ analytics, settings }) => {
  const shop = String(settings.shop || "");
  const api = String(settings.api || "");
  if (!shop || !api) return;

  analytics.subscribe("checkout_completed", (event) => {
    const checkout = event.data.checkout;
    const orderId = checkout.order?.id || checkout.token;
    if (!orderId) return;

    type Agg = { d: string; a: string; units: number; revenue: number; single: Record<string, number> };
    const deals: Record<string, Agg> = {};

    for (const line of checkout.lineItems || []) {
      const props: Record<string, string> = {};
      for (const p of line.properties || []) props[p.key] = p.value;
      const dealId = props._cartlift || (props._cartlift_gift ?? "") || (props._cartlift_upsell ?? "").split(":")[0];
      if (!dealId) continue;

      const agg = (deals[dealId] ||= { d: dealId, a: props._cartlift_arm || "A", units: 0, revenue: 0, single: {} });
      const paid = Number(line.finalLinePrice?.amount ?? 0);
      agg.revenue += paid;
      if (props._cartlift) {
        agg.units += line.quantity;
        const productId = line.variant?.product?.id || line.variant?.id || "x";
        const unit = Number(line.variant?.price?.amount ?? 0);
        agg.single[productId] = Math.max(agg.single[productId] || 0, unit);
      }
    }

    const payload = Object.values(deals).map((agg) => {
      const single = Object.values(agg.single).reduce((s, v) => s + v, 0);
      return {
        d: agg.d,
        a: agg.a,
        units: agg.units,
        revenue: Math.round(agg.revenue * 100) / 100,
        added: Math.max(0, Math.round((agg.revenue - single) * 100) / 100),
      };
    });
    if (!payload.length) return;

    fetch(api, {
      method: "POST",
      keepalive: true,
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({
        shop,
        events: [{ t: "order", o: String(orderId), cur: checkout.currencyCode, deals: payload }],
      }),
    }).catch(() => {});
  });
});
