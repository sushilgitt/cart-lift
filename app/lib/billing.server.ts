import type { Plan } from "@prisma/client";
import prisma from "../db.server";
import { PLANS } from "./plans";
import { gql, type AdminGraphql } from "./shop.server";

/**
 * Shopify managed pricing (App Pricing).
 *
 * Plans, prices, trials and annual options are configured in the Partner
 * dashboard; Shopify hosts the plan-selection page and does the invoicing.
 * CartLift never calls the Billing API (appSubscriptionCreate). It only:
 *  1. sends the merchant to Shopify's hosted pricing page, and
 *  2. reads the active subscription back to decide which plan applies.
 *
 * The `plan_handle` / `charge_id` query parameters Shopify appends on return
 * are user-controlled, so they are ignored; the subscription is always read
 * from the Admin API.
 */

let cachedHandle: string | null = null;

/** The app's handle as Shopify knows it — part of the hosted pricing URL. */
export async function appHandle(admin: AdminGraphql): Promise<string> {
  if (cachedHandle) return cachedHandle;
  try {
    const data = await gql<{ currentAppInstallation: { app: { handle: string | null } } }>(
      admin,
      `#graphql
        query cartliftAppHandle { currentAppInstallation { app { handle } } }`,
    );
    const handle = data.currentAppInstallation.app.handle;
    if (handle) cachedHandle = handle;
  } catch (error) {
    console.error("Could not read app handle", error);
  }
  return cachedHandle || process.env.SHOPIFY_APP_HANDLE || "cartlift-19";
}

/**
 * Bigger plan wins when a store somehow has two active subscriptions. The FLEX
 * tiers are retired and no longer sold; they stay here because the database
 * enum still has them (Postgres cannot drop an enum value).
 */
const RANK: Record<Plan, number> = {
  FREE: 0,
  STARTER: 1,
  SCALE: 2,
  PRO: 3,
  FLEX20: 3,
  FLEX30: 3,
  FLEX40: 3,
  FLEX50: 3,
};

/**
 * Maps a Partner-dashboard plan handle or name onto our Plan enum.
 * Accepts suffixed handles such as `starter-annual` or `pro-yearly`, so annual
 * variants of a plan grant the same limits as the monthly one.
 */
export function planFor(identifier?: string | null): Plan | null {
  if (!identifier) return null;
  const key = identifier.trim().toLowerCase();
  const match = PLANS.find(
    (p) =>
      key === p.handle ||
      key === p.name.toLowerCase() ||
      key.startsWith(`${p.handle}-`) ||
      key.startsWith(`${p.handle}_`) ||
      key.startsWith(`${p.name.toLowerCase()} `),
  );
  return match?.id ?? null;
}

interface Subscription {
  name: string;
  status: string;
  test: boolean;
  lineItems?: { plan?: { pricingDetails?: { planHandle?: string | null } | null } | null }[];
}

/**
 * Reconciles the stored plan with the merchant's real subscription. Runs on
 * every admin load, so cancellations and failed payments take effect without
 * the merchant revisiting the pricing page. Returns null if Shopify couldn't
 * be reached; the stored plan is kept then (never demote on a transient error).
 */
export async function syncPlanFromShopify(admin: AdminGraphql, domain: string): Promise<Plan | null> {
  let subs: Subscription[];
  try {
    const data = await gql<{ currentAppInstallation: { activeSubscriptions: Subscription[] } }>(
      admin,
      `#graphql
        query cartliftSubscriptions {
          currentAppInstallation {
            activeSubscriptions {
              name
              status
              test
              lineItems { plan { pricingDetails { ... on AppRecurringPricing { planHandle } } } }
            }
          }
        }`,
    );
    subs = data.currentAppInstallation.activeSubscriptions ?? [];
  } catch (error) {
    console.error(`Could not read subscriptions for ${domain}`, error);
    return null;
  }

  // Test subscriptions are how development stores exercise billing, so they count.
  const plan =
    subs
      .filter((s) => s.status?.toUpperCase() === "ACTIVE")
      .map((s) => {
        const handle = s.lineItems?.map((l) => l.plan?.pricingDetails?.planHandle).find(Boolean);
        return planFor(handle) ?? planFor(s.name);
      })
      .filter((p): p is Plan => p !== null)
      .sort((a, b) => RANK[b] - RANK[a])[0] ?? "FREE";

  await prisma.shop.updateMany({ where: { domain, NOT: { plan } }, data: { plan } });
  return plan;
}

/** Added revenue so far this calendar month (UTC), in shop currency. */
export async function monthlyUsage(shopId: string) {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const agg = await prisma.dailyStat.aggregate({
    where: { shopId, day: { gte: start } },
    _sum: { addedRevenue: true },
  });
  return Number(agg._sum.addedRevenue ?? 0);
}
