import { register, type Checkout } from "@shopify/web-pixels-extension";

/**
 * Attributes checkouts to CartLift deals.
 *
 * The widget tags deal lines with `_cartlift` (deal id) and `_cartlift_arm`;
 * complete-the-bundle lines with `_cartlift_bundle` (`dealId:barId`), the
 * viewed product among them with `_cartlift_main`; gifts `_cartlift_gift`,
 * upsells `_cartlift_upsell`. It also remembers the deals a visitor saw
 * (`cartlift_seen` in localStorage).
 *
 *  - checkout_started: which deals the checkout contains (checkout rate).
 *  - checkout_completed: per deal, units, revenue after line discounts and
 *    "added revenue" (what was paid beyond a single unit, the number Kaching
 *    reports and bills on); every CartLift line, for bar / product / feature
 *    analytics; and the deals the visitor saw, for visitor conversion.
 */
register(({ analytics, settings, browser }) => {
  const shop = String(settings.shop || "");
  const api = String(settings.api || "");
  if (!shop || !api) return;

  type Agg = { d: string; a: string; units: number; revenue: number; single: Record<string, number> };
  type Line = { d: string; a: string; k: "deal" | "bundle" | "gift" | "upsell"; p: string; v: string; q: number; r: number; u: number; b?: string; t?: string; m?: 1; sp?: 1 };

  const money = (n: number) => Math.round(n * 100) / 100;
  const numeric = (gid: unknown) => String(gid ?? "").split("/").pop() || "";

  /** CartLift lines of a checkout, and per-deal totals. */
  function read(checkout: Checkout) {
    const deals: Record<string, Agg> = {};
    const lines: Line[] = [];
    for (const line of checkout.lineItems || []) {
      const props: Record<string, string> = {};
      for (const p of line.properties || []) props[p.key] = p.value;
      const [bundleDeal, bundleBar] = (props._cartlift_bundle ?? "").split(":");
      const kind: Line["k"] | null = props._cartlift
        ? "deal"
        : bundleDeal
          ? "bundle"
          : props._cartlift_gift
            ? "gift"
            : props._cartlift_upsell
              ? "upsell"
              : null;
      if (!kind) continue;
      const dealId = props._cartlift || bundleDeal || props._cartlift_gift || (props._cartlift_upsell ?? "").split(":")[0];
      if (!dealId) continue;
      const arm = props._cartlift_arm || "A";

      const agg = (deals[dealId] ||= { d: dealId, a: arm, units: 0, revenue: 0, single: {} });
      const paid = Number(line.finalLinePrice?.amount ?? 0);
      const unit = Number(line.variant?.price?.amount ?? 0);
      agg.revenue += paid;
      if (kind === "deal" || kind === "bundle") {
        agg.units += line.quantity;
        // Added revenue is what was paid beyond one unit of each deal product;
        // for a bundle, beyond one unit of the main product only.
        if (kind === "deal" || props._cartlift_main) {
          const productId = line.variant?.product?.id || line.variant?.id || "x";
          agg.single[productId] = Math.max(agg.single[productId] || 0, unit);
        }
      }
      lines.push({
        d: dealId,
        a: arm,
        k: kind,
        p: numeric(line.variant?.product?.id),
        v: numeric(line.variant?.id),
        q: line.quantity,
        r: money(paid),
        u: money(unit),
        ...(bundleBar ? { b: bundleBar } : {}),
        ...(props._cartlift_bar ? { t: props._cartlift_bar } : {}),
        ...(props._cartlift_main ? { m: 1 as const } : {}),
        ...(line.sellingPlanAllocation ? { sp: 1 as const } : {}),
      });
    }
    return { deals: Object.values(deals), lines };
  }

  /** Deals this visitor saw on the storefront: { dealId: arm }. */
  async function seenDeals(): Promise<{ d: string; a: string }[]> {
    try {
      const raw = await browser.localStorage.getItem("cartlift_seen");
      const seen = raw ? (JSON.parse(raw) as Record<string, string>) : {};
      return Object.entries(seen)
        .slice(0, 20)
        .map(([d, a]) => ({ d, a: typeof a === "string" ? a : "A" }));
    } catch {
      return [];
    }
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
    const deals = read(checkout).deals.map((agg) => ({ d: agg.d, a: agg.a }));
    if (deals.length) send({ t: "checkout", o: checkout.token, deals });
  });

  analytics.subscribe("checkout_completed", async (event) => {
    const checkout = event.data.checkout;
    const orderId = checkout.order?.id || checkout.token;
    if (!orderId) return;

    const { deals, lines } = read(checkout);
    const seen = await seenDeals();
    if (!deals.length && !seen.length) return;
    send({
      t: "order",
      o: String(orderId),
      cur: checkout.currencyCode,
      deals: deals.map((agg) => {
        const single = Object.values(agg.single).reduce((s, v) => s + v, 0);
        return {
          d: agg.d,
          a: agg.a,
          units: agg.units,
          revenue: money(agg.revenue),
          added: Math.max(0, money(agg.revenue - single)),
        };
      }),
      lines: lines.slice(0, 100),
      seen,
    });
  });
});
