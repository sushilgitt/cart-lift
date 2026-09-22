import { matchesTarget, reachedBar, type Targeted } from "./tiers";

/**
 * Cart planning for the storefront cart watcher. Mirrors the Discount
 * Function's counting (extensions/cartlift-discount), so what the watcher puts
 * in the cart is what checkout makes free.
 */

/** A line of the Ajax Cart API (/cart.js). */
export interface AjaxLine {
  key: string;
  product_id: number;
  variant_id: number;
  quantity: number;
  properties?: Record<string, string> | null;
  selling_plan_allocation?: unknown;
}

export interface AjaxCart {
  token?: string;
  items: AjaxLine[];
}

/** One deal as published in the gift config (app/lib/sync.server.ts → buildGiftConfig). */
export interface GiftDeal extends Targeted<number> {
  id: string;
  across?: boolean;
  bars: { id: string; q: number; gift?: number }[];
}

export interface GiftConfig {
  deals: GiftDeal[];
}

/** productId → collection ids, as known on the storefront. */
export type Collections = Record<number, number[]>;

export interface GiftAdd {
  key: string;
  id: number;
  quantity: number;
  properties: { _cartlift_gift: string };
}

export interface GiftPlan {
  /** Gifts the cart has earned, by gift key. */
  want: Record<string, { deal: string; variant: number }>;
  /** Earned gifts already in the cart. */
  present: string[];
  /** Line key → new quantity (0 removes). */
  updates: Record<string, number>;
  adds: GiftAdd[];
}

export const giftKey = (dealId: string, variantId: number | string) => `${dealId}|${Number(variantId)}`;

/**
 * The cart changes that bring gift lines in line with the reached bars:
 * add earned gifts (unless in `skip`), remove unearned ones, one unit each.
 * Returns null when unsure (a line's collections are unknown).
 */
export function planGifts(
  config: GiftConfig,
  cart: AjaxCart,
  cols: Collections,
  skip: Record<string, boolean> = {},
): GiftPlan | null {
  const deals = config.deals ?? [];
  const items = cart.items ?? [];
  const byId = new Map(deals.map((d) => [d.id, d]));

  const eligible = (deal: GiftDeal, line: AjaxLine) => {
    const member = cols[Number(line.product_id)];
    return matchesTarget(deal, Number(line.product_id), (c) => (member ? member.includes(Number(c)) : null));
  };

  // 1. Group deal units exactly like the Function.
  const groups = new Map<string, { deal: GiftDeal; units: number; bar: string | null }>();
  for (const line of items) {
    const props = line.properties ?? {};
    if (props._cartlift_gift || props._cartlift_upsell) continue;

    let deal: GiftDeal | null = null;
    const tagged = props._cartlift ? byId.get(props._cartlift) : undefined;
    if (tagged) {
      const ok = eligible(tagged, line);
      if (ok === null) return null;
      if (ok) deal = tagged;
    }
    if (!deal) {
      for (const d of deals) {
        const ok = eligible(d, line);
        if (ok === null) return null;
        if (ok) {
          deal = d;
          break;
        }
      }
    }
    if (!deal) continue;

    const key = deal.across ? deal.id : `${deal.id}|${line.product_id}`;
    let group = groups.get(key);
    if (!group) {
      group = { deal, units: 0, bar: null };
      groups.set(key, group);
    }
    group.units += Number(line.quantity) || 0;
    if (props._cartlift_bar && !group.bar) group.bar = props._cartlift_bar;
  }

  // 2. Gifts the reached bars unlock: one unit per (deal, gift variant).
  const want: GiftPlan["want"] = {};
  for (const g of groups.values()) {
    const bar = reachedBar(g.deal.bars ?? [], g.units, g.bar);
    if (bar?.gift) want[giftKey(g.deal.id, bar.gift)] = { deal: g.deal.id, variant: Number(bar.gift) };
  }

  // 3. Compare with the gift lines in the cart.
  const have = new Map<string, AjaxLine[]>();
  for (const line of items) {
    const dealId = line.properties?._cartlift_gift;
    if (!dealId) continue;
    const k = giftKey(dealId, line.variant_id);
    have.set(k, [...(have.get(k) ?? []), line]);
  }

  const updates: Record<string, number> = {};
  const present: string[] = [];
  for (const [k, lines] of have) {
    lines.forEach((line, index) => {
      const qty = want[k] && index === 0 ? 1 : 0;
      if (Number(line.quantity) !== qty) updates[line.key] = qty;
    });
    if (want[k]) present.push(k);
  }

  const adds: GiftAdd[] = [];
  for (const k of Object.keys(want)) {
    if (have.has(k) || skip[k]) continue;
    adds.push({ key: k, id: want[k].variant, quantity: 1, properties: { _cartlift_gift: want[k].deal } });
  }

  return { want, present, updates, adds };
}

/**
 * Plain lines (no properties, no selling plan) whose variant also has a
 * CartLift-tagged line: their quantity moves onto the tagged line. Checkout
 * prices the same either way; the cart just shows one line, like Kaching.
 *
 * @returns line key → new quantity for /cart/update.js (empty = nothing to do)
 */
export function mergePlan(cart: AjaxCart): Record<string, number> {
  const byVariant = new Map<number, { tagged: AjaxLine | null; plain: AjaxLine[] }>();
  for (const line of cart.items ?? []) {
    if (line.selling_plan_allocation) continue;
    const props = line.properties ?? {};
    let entry = byVariant.get(line.variant_id);
    if (!entry) {
      entry = { tagged: null, plain: [] };
      byVariant.set(line.variant_id, entry);
    }
    if (props._cartlift && !props._cartlift_gift && !props._cartlift_upsell) {
      entry.tagged ??= line;
    } else if (!Object.keys(props).length) {
      entry.plain.push(line);
    }
  }

  const updates: Record<string, number> = {};
  for (const { tagged, plain } of byVariant.values()) {
    if (!tagged || !plain.length) continue;
    let total = Number(tagged.quantity) || 0;
    for (const line of plain) {
      total += Number(line.quantity) || 0;
      updates[line.key] = 0;
    }
    updates[tagged.key] = total;
  }
  return updates;
}
