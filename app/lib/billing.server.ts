import type { Plan } from "@prisma/client";
import prisma from "../db.server";
import { PLANS } from "./plans";
import { gql, type AdminGraphql } from "./shop.server";

/**
 * Shopify managed pricing: Shopify hosts the plan page, trials and invoices;
 * we only read which plan is active. The `plan_handle` query parameter on the
 * return URL is user-controlled and deliberately ignored.
 */

const APP_HANDLE = process.env.SHOPIFY_APP_HANDLE || "cartlift";

export function pricingPageUrl(domain: string) {
  const store = domain.replace(/\.myshopify\.com$/, "");
  return `https://admin.shopify.com/store/${store}/charges/${APP_HANDLE}/pricing_plans`;
}

const RANK: Record<Plan, number> = { FREE: 0, STARTER: 1, SCALE: 2, PRO: 3 };

function planFor(identifier?: string | null): Plan | null {
  if (!identifier) return null;
  const key = identifier.trim().toLowerCase();
  return PLANS.find((p) => p.handle === key || p.name.toLowerCase() === key)?.id ?? null;
}

interface Subscription {
  name: string;
  status: string;
  lineItems?: { plan?: { pricingDetails?: { planHandle?: string | null } | null } | null }[];
}

/** Returns null if Shopify couldn't be reached; the stored plan is kept then. */
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
