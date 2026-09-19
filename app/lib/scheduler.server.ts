import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import { syncShop } from "./sync.server";

/**
 * Republishes shops whose deals started or ended since the last tick.
 *
 * The Function has no reliable clock per deal, so scheduled deals are enforced
 * by publishing only live deals. The storefront widget also checks the dates
 * itself, so a deal disappears from product pages on time even between ticks.
 */

const TICK_MS = 5 * 60 * 1000;
let lastTick = new Date();

async function tick() {
  const now = new Date();
  const since = lastTick;
  lastTick = now;

  const deals = await prisma.deal.findMany({
    where: {
      status: "ACTIVE",
      OR: [
        { startsAt: { gt: since, lte: now } },
        { endsAt: { gt: since, lte: now } },
      ],
    },
    select: { shop: { select: { domain: true, uninstalledAt: true } } },
  });
  const domains = new Set(
    deals.filter((d) => !d.shop.uninstalledAt).map((d) => d.shop.domain),
  );

  for (const domain of domains) {
    try {
      const { admin } = await unauthenticated.admin(domain);
      await syncShop(admin, domain);
      console.log(`Scheduler republished ${domain}`);
    } catch (error) {
      console.error(`Scheduler failed for ${domain}`, error);
    }
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __cartliftScheduler: NodeJS.Timeout | undefined;
}

export function startScheduler() {
  if (process.env.NODE_ENV !== "production" || global.__cartliftScheduler) return;
  global.__cartliftScheduler = setInterval(() => {
    tick().catch((error) => console.error("Scheduler tick failed", error));
  }, TICK_MS);
}
