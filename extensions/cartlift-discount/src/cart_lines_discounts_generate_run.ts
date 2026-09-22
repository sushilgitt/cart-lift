import {
  DiscountClass,
  ProductDiscountSelectionStrategy,
  CartInput,
  CartLinesDiscountsGenerateRunResult,
  ProductDiscountCandidate,
} from "../generated/api";
import { matchesTarget, reachedBar } from "../../../packages/core/src";

/**
 * CartLift pricing engine.
 *
 * The config is published by the app (app/lib/sync.server.ts → buildFunctionConfig)
 * onto this discount's `$app:cartlift/config` metafield. Its `collectionIds` key
 * doubles as the input-query variable for `inCollections`.
 *
 * Counting rules, mirroring Kaching:
 *  - Units of an eligible product count wherever they were added from, so a
 *    shopper adding the same product twice still climbs the tiers.
 *  - A line tagged `_cartlift=<dealId>` prefers that deal; untagged lines go to
 *    the first eligible deal (config order is priority order).
 *  - Units are grouped per (deal, product), or per deal when `across` is set.
 *  - Bars may share a quantity (their discounts are then equal); `_cartlift_bar`
 *    on the group's lines says which one the shopper picked, else the first.
 *  - Gift and upsell lines never count toward tiers.
 */

type DiscountType = "none" | "percentage" | "amount" | "fixed_total";

export interface FnUpsell {
  id: string;
  /** Variant GID the discount is bound to. Missing (old config) = no discount. */
  v?: string;
  /**
   * Complementary upsell: instead of one variant, any product Shopify lists as
   * complementary to a deal product in the cart (Search & Discovery), up to `l`.
   */
  c?: 1;
  l?: number;
  dt: DiscountType;
  dv: number;
}

export interface FnBar {
  id: string;
  /** Units the bar needs. For BXGY this is buy + get. */
  q: number;
  /** "q" quantity break, "x" buy X get Y. */
  k: "q" | "x";
  /** BXGY: discounted units per set. */
  g?: number;
  dt: DiscountType;
  dv: number;
  /** Discount title shown in cart/checkout. */
  m?: string;
  /** BXGY: extra percentage off on top of the free items. */
  xp?: number;
  /** Free gift variant GID. */
  gift?: string;
  ups?: FnUpsell[];
}

export interface FnDeal {
  id: string;
  tt: "ALL" | "PRODUCTS" | "COLLECTIONS" | "EXCEPT";
  p?: string[];
  c?: string[];
  across?: boolean;
  name: string;
  bars: FnBar[];
  arms?: Record<string, FnBar[]>;
}

export interface FnConfig {
  collectionIds?: string[];
  deals?: FnDeal[];
}

type Line = CartInput["cart"]["lines"][number];

interface Group {
  deal: FnDeal;
  lines: Line[];
  units: number;
  arm: string;
  /** Bar id the widget tagged the lines with, if any. */
  bar?: string;
}

interface Candidate {
  message: string;
  targets: { cartLine: { id: string; quantity?: number } }[];
  value:
    | { percentage: { value: number } }
    | { fixedAmount: { amount: number; appliesToEachItem?: boolean } };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function productOf(line: Line) {
  const m = line.merchandise;
  return m.__typename === "ProductVariant" ? m : null;
}

function isEligible(deal: FnDeal, line: Line): boolean {
  const variant = productOf(line);
  if (!variant) return false;
  const member = new Map(variant.product.inCollections.map((m) => [m.collectionId, m.isMember]));
  // The input query asks about every targeted collection, so membership is always known.
  return matchesTarget(deal, variant.product.id, (c) => member.get(c) ?? false) === true;
}

export function barsFor(deal: FnDeal, arm: string): FnBar[] {
  const bars = (arm !== "A" && deal.arms?.[arm]) || deal.bars;
  return [...bars].sort((a, b) => a.q - b.q);
}

const price = (line: Line) => Number(line.cost.amountPerQuantity.amount);

/** Product GIDs Search & Discovery lists as complementary to this line's product. */
function complementaryOf(line: Line): string[] {
  const raw = productOf(line)?.product.complementary?.value;
  if (!raw) return [];
  try {
    const ids = JSON.parse(raw);
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function quantityBreak(group: Group, bar: FnBar, rate: number, message: string): Candidate[] {
  const targets = group.lines.map((line) => ({ cartLine: { id: line.id } }));
  const value = Number(bar.dv) || 0;
  if (value <= 0) return [];

  if (bar.dt === "percentage") {
    return [{ message, targets, value: { percentage: { value: Math.min(value, 100) } } }];
  }
  if (bar.dt === "amount") {
    return [
      {
        message,
        targets,
        value: { fixedAmount: { amount: round2(value * rate), appliesToEachItem: true } },
      },
    ];
  }
  if (bar.dt === "fixed_total") {
    // "3 for $50" → every unit costs 50/3; the difference comes off the group.
    const unitTarget = (value / bar.q) * rate;
    const full = group.lines.reduce((sum, l) => sum + price(l) * l.quantity, 0);
    const off = round2(full - unitTarget * group.units);
    if (off <= 0) return [];
    return [{ message, targets, value: { fixedAmount: { amount: off } } }];
  }
  return [];
}

/** Discount on one "Y" unit of a BXGY bar. */
function yUnitOff(bar: FnBar, unit: number, rate: number): number {
  const dv = Number(bar.dv) || 0;
  if (bar.dt === "none") return unit;
  if (bar.dt === "percentage") return (unit * Math.min(dv, 100)) / 100;
  if (bar.dt === "amount") return Math.min(dv * rate, unit);
  return Math.max(0, unit - dv * rate); // fixed price for each Y unit
}

function buyXGetY(group: Group, bar: FnBar, rate: number, message: string): Candidate[] {
  const get = Math.max(0, Math.floor(bar.g ?? 0));
  if (get <= 0 || bar.q <= get) return [];
  let free = Math.floor(group.units / bar.q) * get;
  if (free <= 0) return [];

  const extra = Math.min(100, Math.max(0, Number(bar.xp) || 0));
  if (extra > 0) {
    // "Buy 3 get 4 + 10%": the Y units get their discount, then every line
    // gets `extra` % off what is left. One amount per line, so nothing stacks.
    const sorted = [...group.lines].sort((a, b) => price(a) - price(b));
    const yUnits = new Map<string, number>();
    for (const line of sorted) {
      const qty = Math.min(free, line.quantity);
      free -= qty;
      yUnits.set(line.id, qty);
    }
    const out: Candidate[] = [];
    for (const line of group.lines) {
      const unit = price(line);
      const yOff = yUnitOff(bar, unit, rate) * (yUnits.get(line.id) ?? 0);
      const off = round2(yOff + ((unit * line.quantity - yOff) * extra) / 100);
      if (off > 0) out.push({ message, targets: [{ cartLine: { id: line.id } }], value: { fixedAmount: { amount: off } } });
    }
    return out;
  }

  // The cheapest units are the "Y" units, as in Shopify's native BXGY.
  const sorted = [...group.lines].sort((a, b) => price(a) - price(b));
  const out: Candidate[] = [];
  for (const line of sorted) {
    if (free <= 0) break;
    const qty = Math.min(free, line.quantity);
    free -= qty;
    const target = [{ cartLine: { id: line.id, quantity: qty } }];
    const unit = price(line);
    const dv = Number(bar.dv) || 0;

    if (bar.dt === "percentage" || bar.dt === "none") {
      const pct = bar.dt === "none" ? 100 : Math.min(dv, 100);
      if (pct > 0) out.push({ message, targets: target, value: { percentage: { value: pct } } });
    } else if (bar.dt === "amount") {
      const each = Math.min(dv * rate, unit);
      if (each > 0)
        out.push({
          message,
          targets: target,
          value: { fixedAmount: { amount: round2(each * qty) } },
        });
    } else if (bar.dt === "fixed_total") {
      // Fixed price for each Y unit.
      const each = unit - dv * rate;
      if (each > 0)
        out.push({
          message,
          targets: target,
          value: { fixedAmount: { amount: round2(each * qty) } },
        });
    }
  }
  return out;
}

/** Discount for the one discounted upsell unit. */
function upsellValue(up: FnUpsell, line: Line, rate: number): Candidate["value"] | null {
  const dv = Number(up.dv) || 0;
  if (dv <= 0) return null;
  if (up.dt === "percentage") return { percentage: { value: Math.min(dv, 100) } };
  if (up.dt === "amount") {
    const off = Math.min(dv * rate, price(line));
    return off > 0 ? { fixedAmount: { amount: round2(off) } } : null;
  }
  if (up.dt === "fixed_total") {
    const off = price(line) - dv * rate;
    return off > 0 ? { fixedAmount: { amount: round2(off) } } : null;
  }
  return null;
}

export function cartLinesDiscountsGenerateRun(
  input: CartInput,
): CartLinesDiscountsGenerateRunResult {
  const empty = { operations: [] };
  if (!input.discount.discountClasses.includes(DiscountClass.Product)) return empty;

  const config = (input.discount.metafield?.jsonValue ?? {}) as FnConfig;
  const deals = config.deals ?? [];
  if (!deals.length || !input.cart.lines.length) return empty;

  const rate = Number(input.presentmentCurrencyRate) || 1;
  const byId = new Map(deals.map((d) => [d.id, d]));
  const groups = new Map<string, Group>();

  for (const line of input.cart.lines) {
    if (line.gift?.value || line.upsell?.value) continue;
    const variant = productOf(line);
    if (!variant) continue;

    const tagged = line.deal?.value ? byId.get(line.deal.value) : undefined;
    const deal =
      tagged && isEligible(tagged, line) ? tagged : deals.find((d) => isEligible(d, line));
    if (!deal) continue;

    const key = deal.across ? deal.id : `${deal.id}|${variant.product.id}`;
    let group = groups.get(key);
    if (!group) {
      group = { deal, lines: [], units: 0, arm: "A" };
      groups.set(key, group);
    }
    group.lines.push(line);
    group.units += line.quantity;
    if (line.arm?.value && group.arm === "A") group.arm = line.arm.value;
    if (line.bar?.value && !group.bar) group.bar = line.bar.value;
  }

  const candidates: Candidate[] = [];
  // Best bar reached per deal, used to unlock gifts and upsells.
  const dealBars = new Map<string, FnBar[]>();

  for (const group of groups.values()) {
    const bars = barsFor(group.deal, group.arm);
    const bar = reachedBar(bars, group.units, group.bar);
    if (!bar) continue;
    const reached = dealBars.get(group.deal.id) ?? [];
    reached.push(bar);
    dealBars.set(group.deal.id, reached);

    const message = bar.m || group.deal.name;
    candidates.push(
      ...(bar.k === "x"
        ? buyXGetY(group, bar, rate, message)
        : quantityBreak(group, bar, rate, message)),
    );
  }

  // Gifts: `_cartlift_gift=<dealId>`. Free only while a reached bar offers that variant.
  const giftsUsed = new Set<string>();
  for (const line of input.cart.lines) {
    const dealId = line.gift?.value;
    const variant = productOf(line);
    if (!dealId || !variant) continue;
    const bar = (dealBars.get(dealId) ?? []).find((b) => b.gift === variant.id);
    const key = `${dealId}|${variant.id}`;
    if (!bar || giftsUsed.has(key)) continue;
    giftsUsed.add(key);
    candidates.push({
      message: bar.m || byId.get(dealId)?.name || "Free gift",
      targets: [{ cartLine: { id: line.id, quantity: 1 } }],
      value: { percentage: { value: 100 } },
    });
  }

  // Products complementary to each deal's products in the cart (Search & Discovery).
  const complementary = new Map<string, Set<string>>();
  for (const group of groups.values()) {
    if (!dealBars.has(group.deal.id)) continue;
    const set = complementary.get(group.deal.id) ?? new Set<string>();
    for (const line of group.lines) {
      for (const id of complementaryOf(line)) set.add(id);
    }
    complementary.set(group.deal.id, set);
  }

  // Upsells: `_cartlift_upsell=<dealId>:<upsellId>`. Discounted while the deal is in the cart.
  // Line properties are shopper-controlled, so the tag alone proves nothing: the line
  // must be the upsell's own variant (or, for complementary upsells, a product Shopify
  // lists as complementary to a deal product in the cart), and only one unit per
  // upsell product is discounted (the widget adds one) — same rule as gifts.
  const upsellsUsed = new Set<string>();
  const complementaryUsed = new Map<string, number>();
  for (const line of input.cart.lines) {
    const tag = line.upsell?.value;
    const variant = productOf(line);
    if (!tag || !variant) continue;
    const [dealId, upsellId] = tag.split(":");
    const deal = byId.get(dealId);
    if (!deal || !dealBars.has(dealId)) continue;
    const allBars = [deal.bars, ...Object.values(deal.arms ?? {})].flat();
    const up = allBars.flatMap((b) => b.ups ?? []).find((u) => u.id === upsellId);
    if (!up) continue;
    let key: string;
    if (up.c) {
      if (!complementary.get(dealId)?.has(variant.product.id)) continue;
      key = `${dealId}|${upsellId}|${variant.product.id}`;
      const count = complementaryUsed.get(`${dealId}|${upsellId}`) ?? 0;
      if (upsellsUsed.has(key) || count >= Math.max(1, up.l ?? 1)) continue;
    } else {
      if (!up.v || up.v !== variant.id) continue;
      key = `${dealId}|${upsellId}`;
      if (upsellsUsed.has(key)) continue;
    }
    const value = upsellValue(up, line, rate);
    if (!value) continue;
    upsellsUsed.add(key);
    if (up.c) complementaryUsed.set(`${dealId}|${upsellId}`, (complementaryUsed.get(`${dealId}|${upsellId}`) ?? 0) + 1);
    candidates.push({ message: deal.name, targets: [{ cartLine: { id: line.id, quantity: 1 } }], value });
  }

  if (!candidates.length) return empty;

  return {
    operations: [
      {
        productDiscountsAdd: {
          // Decimal is typed as string, but Shopify accepts JSON numbers.
          candidates: candidates as unknown as ProductDiscountCandidate[],
          selectionStrategy: ProductDiscountSelectionStrategy.All,
        },
      },
    ],
  };
}
