import type { Plan } from "@prisma/client";

/**
 * Plans are billed on monthly *added revenue* — what shoppers paid beyond a
 * single unit on CartLift deals — like Kaching. Prices live in the Partner
 * dashboard (Shopify managed pricing); the handles here must match.
 *
 * Going over the limit never pauses deals. The merchant sees a banner and an
 * upgrade prompt instead: silently switching off a merchant's offers is the
 * complaint we are designing against.
 *
 * Development stores are free: `Shop.devStore` skips the limit entirely.
 */
export interface PlanDefinition {
  id: Plan;
  handle: string;
  name: string;
  price: number;
  /**
   * Billed once a year instead of monthly, in USD. Shopify shows both options
   * on the hosted pricing page; the annual handle is `<handle>-annual`.
   */
  annualPrice: number;
  /** Added revenue per calendar month, in USD. */
  limit: number;
  features: string[];
}

/** Free days before the first charge, set on every paid plan in the Partner dashboard. */
export const TRIAL_DAYS = 7;

/** Paying for a year costs about this much less than twelve monthly charges. */
export const ANNUAL_DISCOUNT = 0.27;

/** A year up front, rounded to the usual .89/.99 shape. */
const yearly = (monthly: number) => Math.round(monthly * 12 * (1 - ANNUAL_DISCOUNT)) - 0.01;

export const PLANS: PlanDefinition[] = [
  {
    id: "FREE",
    handle: "free",
    name: "Free",
    price: 0,
    annualPrice: 0,
    limit: 250,
    features: ["All deal types", "Unlimited deals", "Up to $250 added revenue / month"],
  },
  {
    id: "STARTER",
    handle: "starter",
    name: "Starter",
    price: 14.99,
    annualPrice: yearly(14.99),
    limit: 1_000,
    features: ["Everything in Free", "Up to $1,000 added revenue / month", "A/B testing", "Chat support"],
  },
  {
    id: "SCALE",
    handle: "scale",
    name: "Scale",
    price: 29.99,
    annualPrice: yearly(29.99),
    limit: 5_000,
    features: ["Everything in Starter", "Up to $5,000 added revenue / month"],
  },
  {
    id: "PRO",
    handle: "pro",
    name: "Pro",
    price: 59.99,
    annualPrice: yearly(59.99),
    limit: 10_000,
    features: ["Everything in Scale", "Up to $10,000 added revenue / month", "Priority support"],
  },
];

/**
 * Plans that were offered once and no longer are. The database enum keeps them
 * (Postgres cannot drop an enum value), so a shop that somehow still carries
 * one is read as the closest plan we do offer rather than silently as Free.
 */
export const RETIRED_PLANS: Record<string, Plan> = {
  FLEX20: "PRO",
  FLEX30: "PRO",
  FLEX40: "PRO",
  FLEX50: "PRO",
};

export const planById = (id: Plan) => PLANS.find((p) => p.id === (RETIRED_PLANS[id] ?? id)) ?? PLANS[0];

/**
 * The cheapest plan that covers this much added revenue, for the upgrade
 * prompt. Above the biggest plan there is nothing left to suggest.
 */
export function planFrom(addedRevenue: number): PlanDefinition | null {
  return PLANS.find((p) => p.limit >= addedRevenue) ?? null;
}
