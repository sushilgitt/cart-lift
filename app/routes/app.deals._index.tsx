import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useNavigate } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { duplicateDeal, getDeal, listDeals } from "../lib/deal.server";
import { syncShop, isLive } from "../lib/sync.server";
import { TEMPLATES, TEMPLATE_INFO, type DealTypeKey, type TemplateKey } from "../lib/deals";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const deals = await listDeals(session.shop);
  const since = new Date(Date.now() - 30 * 86400_000);
  const stats = await prisma.dailyStat.groupBy({
    by: ["dealId"],
    where: { shop: { domain: session.shop }, day: { gte: since } },
    _sum: { views: true, orders: true, revenue: true },
  });
  const byDeal = Object.fromEntries(stats.map((s) => [s.dealId, s._sum]));
  return {
    deals: deals.map((d) => ({
      id: d.id,
      name: d.name,
      type: d.type as DealTypeKey,
      status: d.status,
      live: isLive(d),
      targetType: d.targetType,
      startsAt: d.startsAt?.toISOString() ?? null,
      endsAt: d.endsAt?.toISOString() ?? null,
      views: byDeal[d.id]?.views ?? 0,
      orders: byDeal[d.id]?.orders ?? 0,
      revenue: Number(byDeal[d.id]?.revenue ?? 0),
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent"));
  const id = String(form.get("id"));
  const deal = await getDeal(session.shop, id);
  if (!deal) return { ok: false, error: "Deal not found." };

  if (intent === "toggle") {
    await prisma.deal.update({
      where: { id },
      data: { status: deal.status === "ACTIVE" ? "PAUSED" : "ACTIVE" },
    });
  } else if (intent === "duplicate") {
    await duplicateDeal(session.shop, id);
  } else if (intent === "delete") {
    await prisma.deal.delete({ where: { id } });
  } else if (intent === "up" || intent === "down") {
    const all = await listDeals(session.shop);
    const i = all.findIndex((d) => d.id === id);
    const j = intent === "up" ? i - 1 : i + 1;
    if (i >= 0 && j >= 0 && j < all.length) {
      [all[i], all[j]] = [all[j], all[i]];
      await prisma.$transaction(
        all.map((d, index) => prisma.deal.update({ where: { id: d.id }, data: { priority: index } })),
      );
    }
  }

  try {
    await syncShop(admin, session.shop);
  } catch (error) {
    console.error("Sync failed", error);
    return { ok: false, error: "Saved, but publishing to your store failed. Try again in a moment." };
  }
  return { ok: true };
};

const STATUS_TONE: Record<string, "success" | "neutral" | "warning" | "info"> = {
  ACTIVE: "success",
  DRAFT: "neutral",
  PAUSED: "warning",
};

export default function Deals() {
  const { deals } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const fetcher = useFetcher<typeof action>();

  const run = (intent: string, id: string) => {
    if (intent === "delete" && !confirm("Delete this deal? Its analytics are deleted too.")) return;
    fetcher.submit({ intent, id }, { method: "post" });
  };

  return (
    <s-page heading="Deals">
      <s-button slot="primary-action" variant="primary" onClick={() => navigate("/app/deals/new?template=quantity_breaks")}>
        Create deal
      </s-button>

      {fetcher.data && !fetcher.data.ok ? (
        <s-banner tone="critical">{fetcher.data.error}</s-banner>
      ) : null}

      <s-section heading="Start from a template">
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(220px, 1fr))" gap="base">
          {(Object.keys(TEMPLATES) as TemplateKey[]).map((key) => (
            <s-box key={key} padding="base" border="base" borderRadius="base">
              <s-stack gap="small-200">
                <s-stack direction="inline" gap="small-200" alignItems="center">
                  <s-heading>{TEMPLATES[key].title}</s-heading>
                  {TEMPLATES[key].available ? null : <s-badge>Coming soon</s-badge>}
                </s-stack>
                <s-paragraph color="subdued">{TEMPLATES[key].description}</s-paragraph>
                <s-button
                  disabled={!TEMPLATES[key].available || undefined}
                  onClick={() => navigate(`/app/deals/new?template=${key}`)}
                >
                  Use template
                </s-button>
              </s-stack>
            </s-box>
          ))}
        </s-grid>
      </s-section>

      <s-section heading="Your deals" padding="none">
        {deals.length === 0 ? (
          <s-box padding="base">
            <s-paragraph>No deals yet. Pick a template above to create your first one.</s-paragraph>
          </s-box>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Deal</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Applies to</s-table-header>
              <s-table-header format="numeric">Views (30d)</s-table-header>
              <s-table-header format="numeric">Orders (30d)</s-table-header>
              <s-table-header>Actions</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {deals.map((deal, index) => (
                <s-table-row key={deal.id}>
                  <s-table-cell>
                    <s-stack gap="small-100">
                      <s-link href={`/app/deals/${deal.id}`}>{deal.name}</s-link>
                      <s-text color="subdued">{TEMPLATE_INFO[deal.type]?.title}</s-text>
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    <s-badge tone={STATUS_TONE[deal.status]}>
                      {deal.status === "ACTIVE" && !deal.live ? "Scheduled" : deal.status.toLowerCase()}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>
                    {
                      {
                        ALL: "All products",
                        PRODUCTS: "Selected products",
                        COLLECTIONS: "Collections",
                        EXCEPT: "All except selected",
                      }[deal.targetType]
                    }
                  </s-table-cell>
                  <s-table-cell>{deal.views}</s-table-cell>
                  <s-table-cell>{deal.orders}</s-table-cell>
                  <s-table-cell>
                    <s-button-group>
                      <s-button onClick={() => run("toggle", deal.id)}>
                        {deal.status === "ACTIVE" ? "Pause" : "Activate"}
                      </s-button>
                      <s-button icon="arrow-up" accessibilityLabel="Move up" disabled={index === 0 || undefined} onClick={() => run("up", deal.id)} />
                      <s-button icon="arrow-down" accessibilityLabel="Move down" disabled={index === deals.length - 1 || undefined} onClick={() => run("down", deal.id)} />
                      <s-button icon="duplicate" accessibilityLabel="Duplicate" onClick={() => run("duplicate", deal.id)} />
                      <s-button icon="delete" tone="critical" accessibilityLabel="Delete" onClick={() => run("delete", deal.id)} />
                    </s-button-group>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section slot="aside" heading="How priority works">
        <s-paragraph>
          When several deals match the same product, the one higher in this list wins. Use the arrows to reorder.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
