import { createHash } from "node:crypto";
import type { Deal, Shop } from "@prisma/client";
import prisma from "../db.server";
import { gql, type AdminGraphql } from "./shop.server";
import {
  armConfig,
  effectiveGifts,
  liveArms,
  type DealConfig,
  metafieldKey,
  mixMatchPool,
  normalizeConfig,
  numericId,
  renderText,
  storefrontDeal,
  type Bar,
  type DealTypeKey,
  type ResourceRef,
} from "./deals";

/**
 * Publishes a shop's live deals to Shopify.
 *
 * Three documents come out of the same deal rows:
 *  - the Function config, on the automatic discount's `$app:cartlift/config`
 *    metafield — what checkout prices from;
 *  - the storefront config, on the AppInstallation's `cartlift/deals`
 *    app-data metafield — what the theme widget renders from via
 *    `app.metafields.cartlift.deals`;
 *  - the gift config, on the AppInstallation's `cartlift/gifts` app-data
 *    metafield — the small slice of the Function config the cart watcher
 *    (cartlift-cart.js) needs on every page to keep free gifts in the cart.
 *
 * All three are rebuilt from scratch every time, so there is no partial-update state
 * to get out of sync. The hash skips the API calls when nothing changed.
 */

const FUNCTION_HANDLE = "cartlift-discount";
const NAMESPACE = "cartlift";

const refs = (value: unknown): ResourceRef[] =>
  Array.isArray(value) ? (value as ResourceRef[]).filter((r) => r && r.id) : [];

/** Deals the storefront and checkout should honour right now. */
export function isLive(deal: Pick<Deal, "status" | "startsAt" | "endsAt">, now = new Date()) {
  if (deal.status !== "ACTIVE") return false;
  if (deal.startsAt && deal.startsAt > now) return false;
  if (deal.endsAt && deal.endsAt <= now) return false;
  return true;
}

function discountMessage(bar: Bar, dealName: string, discountName: string) {
  if (discountName.trim()) return discountName.trim();
  const text = renderText(bar.title, {
    quantity: bar.qty,
    saved_percentage: bar.discountType === "percentage" ? `${bar.discountValue}%` : "",
  }).trim();
  return !text || text.includes("{{") ? dealName : text;
}

export function buildFunctionConfig(deals: Deal[]) {
  const collectionIds = new Set<string>();
  const out = deals.map((deal) => {
    const config = normalizeConfig(deal.config, deal.type as DealTypeKey);
    const collections = refs(deal.collections).map((c) => c.id);
    if (deal.targetType === "COLLECTIONS") collections.forEach((c) => collectionIds.add(c));
    // Mix & match pool: products that also count toward the tiers.
    const pool = mixMatchPool(config, deal);
    if (pool?.tt === "COLLECTIONS") pool.collections.forEach((c) => collectionIds.add(c.id));
    const bars = functionBars(config, deal.name);
    // A running A/B test: the Function prices lines tagged with an arm by that arm's bars.
    const arms = liveArms(config).filter((k) => k !== "A");
    return {
      id: deal.id,
      tt: deal.targetType,
      p: refs(deal.products).map((p) => p.id),
      c: collections,
      across: config.across,
      ...(pool ? { mm: { tt: pool.tt, p: pool.products.map((p) => p.id), c: pool.collections.map((c) => c.id) } } : {}),
      name: deal.name,
      bars,
      ...(arms.length ? { arms: Object.fromEntries(arms.map((k) => [k, functionBars(armConfig(config, k), deal.name)])) } : {}),
    };
  });
  return { collectionIds: [...collectionIds], deals: out };
}

function functionBars(config: DealConfig, dealName: string) {
  return config.bars.map((bar) => ({
    id: bar.id,
    q: bar.qty,
    k: bar.kind === "bxgy" ? "x" : bar.kind === "bundle" ? "b" : "q",
    ...(bar.kind === "bxgy" ? { g: bar.get } : {}),
    dt: bar.discountType,
    dv: bar.discountValue,
    m: discountMessage(bar, dealName, config.discountName),
    ...(bar.kind === "bxgy" && bar.extraPercent > 0 ? { xp: bar.extraPercent } : {}),
    ...(bar.kind === "bundle"
      ? { it: bar.items.map((it) => ({ v: it.variant?.id ?? null, q: it.qty, dt: it.discountType, dv: it.discountValue })) }
      : {}),
    ...(effectiveGifts(config, bar).length ? { gifts: effectiveGifts(config, bar).map((g) => g.id) } : {}),
    ...(bar.upsells.length
      ? {
          ups: bar.upsells
            .filter((u) => u.source === "complementary" || u.variant)
            .map((u) =>
              u.source === "complementary"
                ? { id: u.id, c: 1, l: u.limit, dt: u.discountType, dv: u.discountValue }
                : { id: u.id, v: u.variant!.id, dt: u.discountType, dv: u.discountValue },
            ),
        }
      : {}),
  }));
}

export function buildStorefrontConfig(shop: Shop, deals: Deal[], appUrl: string) {
  const settings = (shop.settings ?? {}) as { customCss?: string };
  // Product metafields the deals use as text variables; Liquid renders their values.
  const mf = new Map<string, { k: string; ns: string; key: string }>();
  for (const deal of deals) {
    for (const m of normalizeConfig(deal.config, deal.type as DealTypeKey).metafieldVars) {
      if (m.namespace && m.key) mf.set(metafieldKey(m), { k: metafieldKey(m), ns: m.namespace, key: m.key });
    }
  }
  return {
    v: 1,
    api: appUrl,
    css: settings.customCss ?? "",
    mf: [...mf.values()],
    deals: deals.map((deal) => storefrontDeal({ ...deal, type: deal.type as DealTypeKey })),
  };
}

/**
 * What the cart watcher needs to decide which free gifts a cart has earned.
 * It mirrors the Function's counting, so it keeps every live deal in priority
 * order — a deal without gifts can still claim a line before a later one.
 * IDs are numeric to match the Ajax Cart API.
 */
export function buildGiftConfig(deals: Deal[]) {
  const id = (gid: string) => Number(numericId(gid));
  const giftBars = (config: DealConfig) =>
    config.bars.map((bar) => {
      const gifts = effectiveGifts(config, bar).map((g) => id(g.id));
      return {
        id: bar.id,
        q: bar.qty,
        ...(gifts.length ? { gifts } : {}),
        ...(bar.kind === "bundle"
          ? { k: "b" as const, items: bar.items.map((it) => ({ v: it.variant ? id(it.variant.id) : null, q: it.qty })) }
          : {}),
      };
    });
  const out = deals.map((deal) => {
    const config = normalizeConfig(deal.config, deal.type as DealTypeKey);
    const pool = mixMatchPool(config, deal);
    const arms = liveArms(config).filter((k) => k !== "A");
    return {
      id: deal.id,
      tt: deal.targetType,
      p: refs(deal.products).map((p) => id(p.id)),
      c: refs(deal.collections).map((c) => id(c.id)),
      across: config.across,
      ...(pool ? { mm: { tt: pool.tt, p: pool.products.map((p) => id(p.id)), c: pool.collections.map((c) => id(c.id)) } } : {}),
      bars: giftBars(config),
      ...(arms.length ? { arms: Object.fromEntries(arms.map((k) => [k, giftBars(armConfig(config, k))])) } : {}),
    };
  });
  // `g` (any gift) gated the watcher before it also merged lines; kept for
  // theme assets still checking it.
  return { v: 2, g: out.some((d) => d.bars.some((b) => b.gifts)), deals: out };
}

const CREATE_DISCOUNT = `#graphql
  mutation cartliftCreateDiscount($discount: DiscountAutomaticAppInput!) {
    discountAutomaticAppCreate(automaticAppDiscount: $discount) {
      automaticAppDiscount { discountId }
      userErrors { field message }
    }
  }`;

const DISCOUNT_EXISTS = `#graphql
  query cartliftDiscountExists($id: ID!) {
    discountNode(id: $id) { id }
  }`;

const SET_METAFIELDS = `#graphql
  mutation cartliftSetMetafields($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      userErrors { field message }
    }
  }`;

const APP_INSTALLATION = `#graphql
  query cartliftInstallation { currentAppInstallation { id } }`;

async function ensureDiscount(admin: AdminGraphql, shop: Shop, functionConfig: string) {
  if (shop.discountId) {
    const data = await gql<{ discountNode: { id: string } | null }>(admin, DISCOUNT_EXISTS, {
      id: shop.discountId,
    });
    if (data.discountNode) return { id: shop.discountId, created: false };
  }

  const data = await gql<{
    discountAutomaticAppCreate: {
      automaticAppDiscount: { discountId: string } | null;
      userErrors: { field: string[]; message: string }[];
    };
  }>(admin, CREATE_DISCOUNT, {
    discount: {
      title: "CartLift deals",
      functionHandle: FUNCTION_HANDLE,
      discountClasses: ["PRODUCT"],
      startsAt: new Date().toISOString(),
      // Same combination rules as Kaching: stacks with order and shipping
      // discounts; other product discounts compete per line.
      combinesWith: { orderDiscounts: true, productDiscounts: false, shippingDiscounts: true },
      metafields: [
        { namespace: `$app:${NAMESPACE}`, key: "config", type: "json", value: functionConfig },
      ],
    },
  });
  const result = data.discountAutomaticAppCreate;
  if (result.userErrors.length || !result.automaticAppDiscount) {
    throw new Error(`Could not create discount: ${JSON.stringify(result.userErrors)}`);
  }
  const id = result.automaticAppDiscount.discountId;
  await prisma.shop.update({ where: { id: shop.id }, data: { discountId: id } });
  return { id, created: true };
}

async function setMetafields(admin: AdminGraphql, metafields: Record<string, unknown>[]) {
  const data = await gql<{ metafieldsSet: { userErrors: { message: string }[] } }>(
    admin,
    SET_METAFIELDS,
    { metafields },
  );
  if (data.metafieldsSet.userErrors.length) {
    throw new Error(`metafieldsSet failed: ${JSON.stringify(data.metafieldsSet.userErrors)}`);
  }
}

export interface SyncResult {
  published: number;
  skipped: boolean;
}

export async function syncShop(
  admin: AdminGraphql,
  domain: string,
  { force = false }: { force?: boolean } = {},
): Promise<SyncResult> {
  const shop = await prisma.shop.findUnique({ where: { domain } });
  if (!shop) throw new Error(`Unknown shop ${domain}`);

  const all = await prisma.deal.findMany({
    where: { shopId: shop.id, status: "ACTIVE" },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
  });
  const live = all.filter((d) => isLive(d));

  const appUrl = process.env.SHOPIFY_APP_URL || "";
  const functionConfig = JSON.stringify(buildFunctionConfig(live));
  const storefrontConfig = JSON.stringify(buildStorefrontConfig(shop, live, appUrl));
  const giftConfig = JSON.stringify(buildGiftConfig(live));
  const hash = createHash("sha256")
    .update(functionConfig)
    .update(storefrontConfig)
    .update(giftConfig)
    .update(shop.discountId ?? "")
    .digest("hex");

  if (!force && hash === shop.publishedHash) return { published: live.length, skipped: true };

  const discount = await ensureDiscount(admin, shop, functionConfig);
  const installation = await gql<{ currentAppInstallation: { id: string } }>(
    admin,
    APP_INSTALLATION,
  );

  const metafields: Record<string, unknown>[] = [
    {
      ownerId: installation.currentAppInstallation.id,
      namespace: NAMESPACE,
      key: "deals",
      type: "json",
      value: storefrontConfig,
    },
    {
      ownerId: installation.currentAppInstallation.id,
      namespace: NAMESPACE,
      key: "gifts",
      type: "json",
      value: giftConfig,
    },
  ];
  if (!discount.created) {
    metafields.push({
      ownerId: discount.id,
      namespace: `$app:${NAMESPACE}`,
      key: "config",
      type: "json",
      value: functionConfig,
    });
  }
  await setMetafields(admin, metafields);

  // Recompute with the (possibly new) discount id so the next call can skip.
  const finalHash = createHash("sha256")
    .update(functionConfig)
    .update(storefrontConfig)
    .update(giftConfig)
    .update(discount.id)
    .digest("hex");
  await prisma.shop.update({
    where: { id: shop.id },
    data: { publishedHash: finalHash, publishedAt: new Date() },
  });

  return { published: live.length, skipped: false };
}
