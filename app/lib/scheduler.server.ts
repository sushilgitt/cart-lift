import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import { syncShop } from "./sync.server";

/**
 * Republishes shops whose deals started or ended since the last tick.
 *
 * The Function has no reliable clock per deal, so scheduled deals are enforced
 * by publishing only live deals. The storefront widget also checks the dates
 * itself, so a deal disappears from product pages on time even between ticks.
 *
 * Shortly after boot every installed shop with active deals is synced once:
 * that catches deals that started or ended while the server was down, and
 * publishes documents added in a new release. syncShop's hash check makes it
 * a database-only no-op for shops that are already up to date.
 */

const TICK_MS = 5 * 60 * 1000;
const STARTUP_DELAY_MS = 30 * 1000;
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

async function reconcileAll() {
  const shops = await prisma.shop.findMany({
    where: { uninstalledAt: null, deals: { some: { status: "ACTIVE" } } },
    select: { domain: true },
  });
  for (const { domain } of shops) {
    try {
      const { admin } = await unauthenticated.admin(domain);
      const result = await syncShop(admin, domain);
      if (!result.skipped) console.log(`Startup sync republished ${domain}`);
    } catch (error) {
      console.error(`Startup sync failed for ${domain}`, error);
    }
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __cartliftScheduler: NodeJS.Timeout | undefined;
}

export function startScheduler() {
  if (process.env.NODE_ENV !== "production" || global.__cartliftScheduler) return;
  setTimeout(() => {
    reconcileAll().catch((error) => console.error("Startup sync failed", error));
  }, STARTUP_DELAY_MS);
  global.__cartliftScheduler = setInterval(() => {
    tick().catch((error) => console.error("Scheduler tick failed", error));
  }, TICK_MS);
}
