import { reachedBar, type Targeted } from "./tiers";
import { bundleSets, dealMatches } from "./bundles";

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

/** A bar as published in the gift config. */
export interface GiftBar {
  id: string;
  q: number;
  /** Free gift variants (progressive gifts already resolved). */
  gifts?: number[];
  /** Before multiple gifts: a single gift variant. */
  gift?: number;
  /** "b": a complete-the-bundle bar, with its items (`v: null` = the viewed product). */
  k?: "b";
  items?: { v: number | null; q: number }[];
}

/** One deal as published in the gift config (app/lib/sync.server.ts → buildGiftConfig). */
export interface GiftDeal extends Targeted<number> {
  id: string;
  across?: boolean;
  /** Mix & match pool: products that also count toward the tiers. */
  mm?: Targeted<number> | null;
  bars: GiftBar[];
  /** Running A/B test: each arm's bars (lines carry `_cartlift_arm`). */
  arms?: Record<string, GiftBar[]>;
  /** Countries of the deal's markets (missing = everywhere). */
  ctry?: string[];
}

/** Bars of an arm, as the Function picks them. */
const armBars = (deal: GiftDeal, arm: string) => (arm !== "A" && deal.arms?.[arm]) || deal.bars;

export const barGifts = (bar: GiftBar): number[] => bar.gifts ?? (bar.gift ? [bar.gift] : []);

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
    return dealMatches(deal, Number(line.product_id), (c) => (member ? member.includes(Number(c)) : null));
  };

  // Complete-the-bundle bars: the sets among the lines tagged for each.
  const bundleLines = new Map<string, AjaxLine[]>();
  for (const line of items) {
    const tag = line.properties?._cartlift_bundle;
    if (tag) bundleLines.set(tag, [...(bundleLines.get(tag) ?? []), line]);
  }
  const reachedBundles: { deal: GiftDeal; bar: GiftBar }[] = [];
  for (const [tag, lines] of bundleLines) {
    const [dealId, barId] = tag.split(":");
    const deal = byId.get(dealId);
    const bar = deal && [deal.bars, ...Object.values(deal.arms ?? {})].flat().find((b) => b.id === barId && b.k === "b");
    if (!deal || !bar) continue;
    const tagged = [];
    for (const line of lines) {
      const main = eligible(deal, line);
      if (main === null) return null;
      tagged.push({ line, variant: Number(line.variant_id), qty: Number(line.quantity) || 0, main });
    }
    if (bundleSets(bar.items ?? [], tagged).sets > 0) reachedBundles.push({ deal, bar });
  }

  // 1. Group deal units exactly like the Function.
  const groups = new Map<string, { deal: GiftDeal; units: number; bar: string | null; arm: string }>();
  for (const line of items) {
    const props = line.properties ?? {};
    if (props._cartlift_gift || props._cartlift_upsell || props._cartlift_bundle) continue;

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
      group = { deal, units: 0, bar: null, arm: "A" };
      groups.set(key, group);
    }
    group.units += Number(line.quantity) || 0;
    if (props._cartlift_bar && !group.bar) group.bar = props._cartlift_bar;
    if (props._cartlift_arm && group.arm === "A") group.arm = props._cartlift_arm;
  }

  // 2. Gifts the reached bars unlock: one unit per (deal, gift variant).
  const want: GiftPlan["want"] = {};
  const unlock = (dealId: string, bar: GiftBar) => {
    for (const gift of barGifts(bar)) want[giftKey(dealId, gift)] = { deal: dealId, variant: Number(gift) };
  };
  for (const g of groups.values()) {
    const bar = reachedBar(armBars(g.deal, g.arm).filter((b) => b.k !== "b"), g.units, g.bar);
    if (bar) unlock(g.deal.id, bar);
  }
  for (const { deal, bar } of reachedBundles) unlock(deal.id, bar);

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
