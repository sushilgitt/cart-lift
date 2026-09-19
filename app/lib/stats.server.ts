import { Prisma } from "@prisma/client";
import prisma from "../db.server";

/**
 * Storefront analytics ingest.
 *
 * Views and add-to-carts come from the widget beacon; orders come from the web
 * pixel on checkout_completed. Everything lands in DailyStat (one row per
 * deal/arm/day). Orders are also written to DealOrder, whose unique key makes
 * pixel retries idempotent.
 */

export type IncomingEvent =
  | { t: "view" | "atc"; d: string; a?: string }
  | {
      t: "order";
      o: string;
      cur?: string;
      deals: { d: string; a?: string; units: number; revenue: number; added: number }[];
    };

const ARM = /^[A-D]$/;
const arm = (a?: string) => (a && ARM.test(a) ? a : "A");
const today = () => new Date(new Date().toISOString().slice(0, 10));
const money = (n: unknown) => {
  const v = Number(n);
  return Number.isFinite(v) && v >= 0 && v < 1e9 ? Math.round(v * 100) / 100 : 0;
};

async function bump(
  shopId: string,
  dealId: string,
  a: string,
  inc: Partial<Record<"views" | "addToCarts" | "orders" | "units", number>> & {
    revenue?: number;
    addedRevenue?: number;
  },
) {
  const day = today();
  const increment = Object.fromEntries(
    Object.entries(inc).map(([k, v]) => [k, { increment: v }]),
  );
  await prisma.dailyStat.upsert({
    where: { dealId_arm_day: { dealId, arm: a, day } },
    create: { shopId, dealId, arm: a, day, ...inc },
    update: increment,
  });
}

export async function ingestEvents(domain: string, events: IncomingEvent[]) {
  const shop = await prisma.shop.findUnique({
    where: { domain },
    select: { id: true, deals: { select: { id: true } } },
  });
  if (!shop) return;
  const known = new Set(shop.deals.map((d) => d.id));

  for (const event of events) {
    if (event.t === "view" || event.t === "atc") {
      if (!known.has(event.d)) continue;
      await bump(shop.id, event.d, arm(event.a), event.t === "view" ? { views: 1 } : { addToCarts: 1 });
      continue;
    }

    if (event.t === "order" && typeof event.o === "string" && Array.isArray(event.deals)) {
      for (const line of event.deals.slice(0, 20)) {
        if (!known.has(line.d)) continue;
        const a = arm(line.a);
        const revenue = money(line.revenue);
        const added = Math.min(money(line.added), revenue);
        const units = Math.max(0, Math.min(1000, Math.floor(Number(line.units) || 0)));
        try {
          await prisma.dealOrder.create({
            data: {
              shopId: shop.id,
              dealId: line.d,
              arm: a,
              orderId: event.o.slice(0, 100),
              currency: event.cur?.slice(0, 3) ?? null,
              units,
              revenue,
              addedRevenue: added,
            },
          });
        } catch (error) {
          // Duplicate delivery of the same order: already counted.
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") continue;
          throw error;
        }
        await bump(shop.id, line.d, a, { orders: 1, units, revenue, addedRevenue: added });
      }
    }
  }
}
