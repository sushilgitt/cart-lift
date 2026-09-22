export type TargetType = "ALL" | "PRODUCTS" | "COLLECTIONS" | "EXCEPT";

export interface Targeted<Id> {
  tt: TargetType;
  /** Products for PRODUCTS / EXCEPT. */
  p?: Id[];
  /** Collections for COLLECTIONS. */
  c?: Id[];
}

/**
 * Whether a product falls under a deal's targeting. `inCollection` answers
 * membership for one collection, or null when it isn't known — then the
 * result is null too (callers decide what "unsure" means).
 */
export function matchesTarget<Id>(
  deal: Targeted<Id>,
  productId: Id,
  inCollection: (collectionId: Id) => boolean | null,
): boolean | null {
  switch (deal.tt) {
    case "ALL":
      return true;
    case "PRODUCTS":
      return (deal.p ?? []).includes(productId);
    case "EXCEPT":
      return !(deal.p ?? []).includes(productId);
    case "COLLECTIONS": {
      let unknown = false;
      for (const c of deal.c ?? []) {
        const member = inCollection(c);
        if (member) return true;
        if (member === null) unknown = true;
      }
      return unknown ? null : false;
    }
    default:
      return false;
  }
}

/**
 * Highest bar whose quantity the units reach. Bars may share a quantity (their
 * discounts are then equal); the one the shopper picked (`preferred`) wins,
 * else the first in the given (editor) order.
 */
export function reachedBar<B extends { id: string; q: number }>(
  bars: readonly B[],
  units: number,
  preferred?: string | null,
): B | null {
  let top = 0;
  for (const bar of bars) if (bar.q > 0 && units >= bar.q && bar.q > top) top = bar.q;
  if (!top) return null;
  const tied = bars.filter((bar) => bar.q === top);
  return tied.find((bar) => preferred != null && bar.id === preferred) ?? tied[0];
}
