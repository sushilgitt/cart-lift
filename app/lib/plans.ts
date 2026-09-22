import type { Plan } from "@prisma/client";

/**
 * Plans are billed on monthly *added revenue* — what shoppers paid beyond a
 * single unit on CartLift deals — like Kaching. Prices live in the Partner
 * dashboard (Shopify managed pricing); the handles here must match.
 *
 * Going over the limit never pauses deals. The merchant sees a banner and an
 * upgrade prompt instead: silently switching off a merchant's offers is the
 * complaint we are designing against.
 */
export interface PlanDefinition {
  id: Plan;
  handle: string;
  name: string;
  price: number;
  /** Added revenue per calendar month, in USD. */
  limit: number;
  features: string[];
}

export const PLANS: PlanDefinition[] = [
  {
    id: "FREE",
    handle: "free",
    name: "Free",
    price: 0,
    limit: 250,
    features: ["All deal types", "Unlimited deals", "Up to $250 added revenue / month"],
  },
  {
    id: "STARTER",
    handle: "starter",
    name: "Starter",
    price: 14.99,
    limit: 1_000,
    features: ["Everything in Free", "Up to $1,000 added revenue / month", "Chat support"],
  },
  {
    id: "SCALE",
    handle: "scale",
    name: "Scale",
    price: 29.99,
    limit: 5_000,
    features: ["Everything in Starter", "Up to $5,000 added revenue / month"],
  },
  {
    id: "PRO",
    handle: "pro",
    name: "Pro",
    price: 59.99,
    limit: 10_000,
    features: ["Everything in Scale", "Up to $10,000 added revenue / month", "Priority support"],
  },
];

export const planById = (id: Plan) => PLANS.find((p) => p.id === id) ?? PLANS[0];
