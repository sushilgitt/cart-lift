import { Prisma, type DealType } from "@prisma/client";
import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import { attributeOrder, type Fact, type OrderLine } from "./attribution";
import { normalizeConfig, type DealConfig, type DealTypeKey } from "./deals";
import { gql } from "./shop.server";
import { shopDay } from "./days";

/**
 * Storefront analytics ingest.
 *
 * Views and add-to-carts come from the widget beacon; checkouts and orders come
 * from the web pixel (checkout_started / checkout_completed). Deal totals land
 * in DailyStat (one row per deal/arm/day); bars, products and features in
 * StatFact. Checkouts and orders are also written to DealCheckout / DealOrder,
 * whose unique keys make reloads and pixel retries count once. Days follow the
 * shop's timezone.
 */

type Seen = { d: string; a?: string };

export type IncomingEvent =
  | { t: "view"; d: string; a?: string; p?: string | number }
  | { t: "atc"; d: string; a?: string; b?: string; p?: string | number }
  | { t: "checkout"; o: string; deals: Seen[] }
  | {
      t: "order";
      o: string;
      cur?: string;
      deals: { d: string; a?: string; units: number; revenue: number; added: number }[];
      /** Every CartLift line (pixel from Phase 3 on). */
      lines?: (OrderLine & { d: string; a?: string; sp?: 1 })[];
      /** Deals the visitor saw (pixel from Phase 3 on). */
      seen?: Seen[];
    };

const ARM = /^[A-D]$/;
const arm = (a?: string) => (a && ARM.test(a) ? a : "A");
const money = (n: unknown) => {
  const v = Number(n);
  return Number.isFinite(v) && v >= 0 && v < 1e9 ? Math.round(v * 100) / 100 : 0;
};
const count = (n: unknown, max = 1000) => Math.max(0, Math.min(max, Math.floor(Number(n) || 0)));
const idString = (v: unknown) => (/^\d{1,20}$/.test(String(v ?? "")) ? String(v) : "");

type DealInc = Partial<
  Record<"views" | "addToCarts" | "checkouts" | "orders" | "eligibleOrders" | "subscribedOrders" | "units", number>
> & { revenue?: number; addedRevenue?: number; cost?: number };

const increment = (inc: Record<string, number>) =>
  Object.fromEntries(Object.entries(inc).filter(([, v]) => v).map(([k, v]) => [k, { increment: v }]));

async function bump(shopId: string, dealId: string, a: string, day: Date, inc: DealInc) {
  await prisma.dailyStat.upsert({
    where: { dealId_arm_day: { dealId, arm: a, day } },
    create: { shopId, dealId, arm: a, day, ...inc },
    update: increment(inc as Record<string, number>),
  });
}

type FactInc = Partial<Record<"views" | "addToCarts" | "orders" | "units", number>> & {
  revenue?: number;
  addedRevenue?: number;
  cost?: number;
};

async function fact(shopId: string, dealId: string, a: string, dim: string, key: string, day: Date, inc: FactInc) {
  if (!key) return;
  await prisma.statFact.upsert({
    where: { dealId_arm_dim_key_day: { dealId, arm: a, dim, key: key.slice(0, 64), day } },
    create: { shopId, dealId, arm: a, dim, key: key.slice(0, 64), day, ...inc },
    update: increment(inc as Record<string, number>),
  });
}

const round = (n: number) => Math.round(n * 100) / 100;
const factInc = (f: Fact): FactInc => ({ orders: f.orders, units: f.units, revenue: round(f.revenue), cost: round(f.cost) });

// ---------------------------------------------------------------------------
// Unit costs (read_inventory), cached per variant for a day
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

async function variantCosts(shop: { id: string; domain: string }, variantIds: string[]): Promise<Map<string, number>> {
  const ids = [...new Set(variantIds.filter(Boolean))].slice(0, 100);
  const out = new Map<string, number>();
  if (!ids.length) return out;
  const cached = await prisma.variantCost.findMany({
    where: { shopId: shop.id, variantId: { in: ids }, updatedAt: { gte: new Date(Date.now() - DAY_MS) } },
  });
  for (const c of cached) if (c.cost != null) out.set(c.variantId, Number(c.cost));
  const missing = ids.filter((id) => !cached.some((c) => c.variantId === id));
  if (!missing.length) return out;

  let fetched: { id: string; cost: number | null }[] = missing.map((id) => ({ id, cost: null }));
  try {
    const { admin } = await unauthenticated.admin(shop.domain);
    const data = await gql<{ nodes: ({ id: string; inventoryItem: { unitCost: { amount: string } | null } | null } | null)[] }>(
      admin,
      `#graphql
        query cartliftVariantCosts($ids: [ID!]!) {
          nodes(ids: $ids) { ... on ProductVariant { id inventoryItem { unitCost { amount } } } }
        }`,
      { ids: missing.map((id) => `gid://shopify/ProductVariant/${id}`) },
    );
    fetched = missing.map((id) => {
      const node = data.nodes.find((n) => n?.id?.endsWith(`/${id}`));
      const amount = node?.inventoryItem?.unitCost?.amount;
      return { id, cost: amount == null ? null : Number(amount) };
    });
  } catch (error) {
    // No read_inventory yet, or Shopify unreachable: remember "no cost" for a day.
    console.error(`Variant costs failed for ${shop.domain}`, error);
  }
  for (const f of fetched) {
    await prisma.variantCost.upsert({
      where: { shopId_variantId: { shopId: shop.id, variantId: f.id } },
      create: { shopId: shop.id, variantId: f.id, cost: f.cost },
      update: { cost: f.cost },
    });
    if (f.cost != null) out.set(f.id, f.cost);
  }
  return out;
}

// ---------------------------------------------------------------------------

async function recordOrderOnce(
  shopId: string,
  dealId: string,
  a: string,
  orderId: string,
  data: { currency: string | null; units: number; revenue: number; addedRevenue: number; bundle: boolean },
): Promise<boolean> {
  try {
    await prisma.dealOrder.create({ data: { shopId, dealId, arm: a, orderId, ...data } });
    return true;
  } catch (error) {
    // Duplicate delivery of the same order: already counted.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return false;
    throw error;
  }
}

export async function ingestEvents(domain: string, events: IncomingEvent[]) {
  const shop = await prisma.shop.findUnique({
    where: { domain },
    select: { id: true, domain: true, timezone: true, deals: { select: { id: true, type: true, config: true } } },
  });
  if (!shop) return;
  const deals = new Map(shop.deals.map((d) => [d.id, d]));
  const configs = new Map<string, DealConfig>();
  const configOf = (d: { id: string; type: DealType; config: unknown }) => {
    let c = configs.get(d.id);
    if (!c) configs.set(d.id, (c = normalizeConfig(d.config, d.type as DealTypeKey)));
    return c;
  };
  const day = shopDay(shop.timezone);

  for (const event of events) {
    if (event.t === "view" || event.t === "atc") {
      if (!deals.has(event.d)) continue;
      const a = arm(event.a);
      const product = idString(event.p);
      if (event.t === "view") {
        await bump(shop.id, event.d, a, day, { views: 1 });
        await fact(shop.id, event.d, a, "product", product, day, { views: 1 });
      } else {
        await bump(shop.id, event.d, a, day, { addToCarts: 1 });
        await fact(shop.id, event.d, a, "product", product, day, { addToCarts: 1 });
        if (typeof event.b === "string") await fact(shop.id, event.d, a, "bar", event.b, day, { addToCarts: 1 });
      }
      continue;
    }

    if (event.t === "checkout" && typeof event.o === "string" && Array.isArray(event.deals)) {
      for (const line of event.deals.slice(0, 20)) {
        if (!deals.has(line.d)) continue;
        try {
          await prisma.dealCheckout.create({
            data: { shopId: shop.id, dealId: line.d, token: event.o.slice(0, 100) },
          });
        } catch (error) {
          // Same checkout reported again (reload, retry): already counted.
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") continue;
          throw error;
        }
        await bump(shop.id, line.d, arm(line.a), day, { checkouts: 1 });
      }
      continue;
    }

    if (event.t === "order" && typeof event.o === "string" && Array.isArray(event.deals)) {
      const orderId = event.o.slice(0, 100);
      const currency = event.cur?.slice(0, 3) ?? null;
      const lines = (Array.isArray(event.lines) ? event.lines : []).slice(0, 100).map((l) => ({
        ...l,
        p: idString(l.p),
        v: idString(l.v),
        q: count(l.q),
        r: money(l.r),
        b: typeof l.b === "string" ? l.b.slice(0, 64) : undefined,
        t: typeof l.t === "string" ? l.t.slice(0, 64) : undefined,
      }));
      const costs = await variantCosts(shop, lines.map((l) => l.v));
      const costOf = (v: string) => costs.get(v) ?? 0;

      // Orders with deal lines.
      const withLines = new Set<string>();
      for (const agg of event.deals.slice(0, 20)) {
        const deal = deals.get(agg.d);
        if (!deal) continue;
        withLines.add(agg.d);
        const a = arm(agg.a);
        const revenue = money(agg.revenue);
        const added = Math.min(money(agg.added), revenue);
        const units = count(agg.units);
        const own = lines.filter((l) => l.d === agg.d);
        if (!(await recordOrderOnce(shop.id, agg.d, a, orderId, { currency, units, revenue, addedRevenue: added, bundle: true })))
          continue;
        const cost = round(own.reduce((s, l) => s + costOf(l.v) * l.q, 0));
        await bump(shop.id, agg.d, a, day, {
          orders: 1,
          eligibleOrders: 1,
          subscribedOrders: own.some((l) => l.sp) ? 1 : 0,
          units,
          revenue,
          addedRevenue: added,
          cost,
        });
        const split = attributeOrder(configOf(deal), a, own, costOf);
        for (const [dim, map] of Object.entries(split)) {
          for (const [key, f] of map as Map<string, Fact>) await fact(shop.id, agg.d, a, dim, key, day, factInc(f));
        }
      }

      // Visitors who saw a deal but bought without it: eligible orders only.
      for (const s of (Array.isArray(event.seen) ? event.seen : []).slice(0, 20)) {
        if (!deals.has(s.d) || withLines.has(s.d)) continue;
        const a = arm(s.a);
        if (!(await recordOrderOnce(shop.id, s.d, a, orderId, { currency, units: 0, revenue: 0, addedRevenue: 0, bundle: false })))
          continue;
        await bump(shop.id, s.d, a, day, { eligibleOrders: 1 });
      }
    }
  }
}
