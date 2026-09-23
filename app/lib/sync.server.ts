import { createHash } from "node:crypto";
import type { Deal, Shop } from "@prisma/client";
import prisma from "../db.server";
import { gql, type AdminGraphql } from "./shop.server";
import {
  armConfig,
  effectiveGifts,
  liveArms,
  type DealConfig,
  DEFAULT_STRINGS,
  metafieldKey,
  mixMatchPool,
  normalizeStrings,
  normalizeConfig,
  normalizePalette,
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
 *    (cartlift-cart.js) needs on every page to keep free gifts in the cart;
 *  - one `cartlift/i18n_<locale>` metafield per translated language, so a page
 *    only loads its own language.
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

/**
 * Country codes per market (read_markets). Deals limited to markets are
 * published with their countries, because the Function sees the buyer's
 * country, not the market.
 */
export async function marketCountries(admin: AdminGraphql): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  try {
    const data = await gql<{
      markets: {
        nodes: { id: string; conditions: { regionsCondition: { regions: { nodes: { code?: string }[] } } | null } | null }[];
      };
    }>(
      admin,
      `#graphql
        query cartliftMarkets {
          markets(first: 50) {
            nodes {
              id
              conditions {
                regionsCondition { regions(first: 250) { nodes { ... on MarketRegionCountry { code } } } }
              }
            }
          }
        }`,
    );
    for (const m of data.markets.nodes) {
      const codes = (m.conditions?.regionsCondition?.regions.nodes ?? [])
        .map((r) => r.code)
        .filter((c): c is string => Boolean(c));
      out.set(m.id, codes);
    }
  } catch (error) {
    console.error("Markets read failed", error);
  }
  return out;
}

/** The countries a deal runs in (empty = everywhere). */
export function dealCountries(config: DealConfig, countries: Map<string, string[]>): string[] {
  if (!config.markets.length) return [];
  const codes = new Set<string>();
  for (const market of config.markets) for (const code of countries.get(market.id) ?? []) codes.add(code);
  return [...codes];
}

export function buildFunctionConfig(deals: Deal[], countries = new Map<string, string[]>()) {
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
      ...(dealCountries(config, countries).length ? { ctry: dealCountries(config, countries) } : {}),
      ...(config.subscriptions.apply === "subscription"
        ? { sub: "s" }
        : config.subscriptions.apply === "onetime"
          ? { sub: "o" }
          : {}),
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

export function buildStorefrontConfig(shop: Shop, deals: Deal[], appUrl: string, countries = new Map<string, string[]>()) {
  const settings = (shop.settings ?? {}) as { customCss?: string; brandPalette?: unknown };
  const palette = normalizePalette(settings.brandPalette);
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
    deals: deals.map((deal) => ({
      ...storefrontDeal({ ...deal, type: deal.type as DealTypeKey }, palette),
      ...(() => {
        const ctry = dealCountries(normalizeConfig(deal.config, deal.type as DealTypeKey), countries);
        return ctry.length ? { ctry } : {};
      })(),
    })),
  };
}

/**
 * What the cart watcher needs to decide which free gifts a cart has earned.
 * It mirrors the Function's counting, so it keeps every live deal in priority
 * order — a deal without gifts can still claim a line before a later one.
 * IDs are numeric to match the Ajax Cart API.
 */
export function buildGiftConfig(deals: Deal[], countries = new Map<string, string[]>()) {
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
      ...(dealCountries(config, countries).length ? { ctry: dealCountries(config, countries) } : {}),
      ...(config.subscriptions.apply === "subscription"
        ? { sub: "s" as const }
        : config.subscriptions.apply === "onetime"
          ? { sub: "o" as const }
          : {}),
      bars: giftBars(config),
      ...(arms.length ? { arms: Object.fromEntries(arms.map((k) => [k, giftBars(armConfig(config, k))])) } : {}),
    };
  });
  // `g` (any gift) gated the watcher before it also merged lines; kept for
  // theme assets still checking it.
  return { v: 2, g: out.some((d) => d.bars.some((b) => b.gifts)), deals: out };
}

/**
 * Deal texts and widget strings per language. One document per language, so a
 * storefront page in German loads German only.
 */
export function buildTranslations(deals: Deal[], shopStrings: unknown) {
  const strings = normalizeStrings(shopStrings);
  const byLocale = new Map<string, { strings?: Record<string, string>; deals: Record<string, unknown> }>();
  const bucket = (locale: string) => {
    let b = byLocale.get(locale);
    if (!b) byLocale.set(locale, (b = { deals: {} }));
    return b;
  };
  for (const [locale, own] of Object.entries(strings)) bucket(locale).strings = own as Record<string, string>;
  for (const deal of deals) {
    const config = normalizeConfig(deal.config, deal.type as DealTypeKey);
    for (const [locale, translation] of Object.entries(config.translations)) {
      const clean = JSON.parse(JSON.stringify(translation)) as Record<string, unknown>;
      if (Object.keys(clean).length) bucket(locale).deals[deal.id] = clean;
    }
  }
  return byLocale;
}

/** Widget strings a language may override (documented for the editor). */
export const STRING_KEYS = Object.keys(DEFAULT_STRINGS);

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
  // Only ask Shopify about markets when a deal is limited to some.
  const usesMarkets = live.some((d) => normalizeConfig(d.config, d.type as DealTypeKey).markets.length);
  const countries = usesMarkets ? await marketCountries(admin) : new Map<string, string[]>();
  const functionConfig = JSON.stringify(buildFunctionConfig(live, countries));
  const storefrontConfig = JSON.stringify(buildStorefrontConfig(shop, live, appUrl, countries));
  const giftConfig = JSON.stringify(buildGiftConfig(live, countries));
  const translations = buildTranslations(live, (shop.settings as { i18n?: unknown } | null)?.i18n);
  // Languages published before but empty now are cleared, not left stale.
  const published = ((shop.settings as { locales?: unknown } | null)?.locales ?? []) as string[];
  const locales = [...new Set([...translations.keys(), ...(Array.isArray(published) ? published : [])])];
  const i18nConfig = JSON.stringify(
    locales.map((locale) => [locale, JSON.stringify(translations.get(locale) ?? { deals: {} })]),
  );
  const hash = createHash("sha256")
    .update(functionConfig)
    .update(storefrontConfig)
    .update(giftConfig)
    .update(i18nConfig)
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
    ...locales.map((locale) => ({
      ownerId: installation.currentAppInstallation.id,
      namespace: NAMESPACE,
      // Metafield keys allow letters, numbers and underscores.
      key: `i18n_${locale.replace(/-/g, "_").toLowerCase()}`,
      type: "json",
      value: JSON.stringify(translations.get(locale) ?? { deals: {} }),
    })),
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
  // metafieldsSet takes 25 at a time.
  for (let i = 0; i < metafields.length; i += 25) await setMetafields(admin, metafields.slice(i, i + 25));

  // Remember which languages exist, so emptying one clears its metafield next time.
  const settings = { ...((shop.settings ?? {}) as object), locales: [...translations.keys()] };
  await prisma.shop.update({ where: { id: shop.id }, data: { settings: settings as never } });

  // Recompute with the (possibly new) discount id so the next call can skip.
  const finalHash = createHash("sha256")
    .update(functionConfig)
    .update(storefrontConfig)
    .update(giftConfig)
    .update(i18nConfig)
    .update(discount.id)
    .digest("hex");
  await prisma.shop.update({
    where: { id: shop.id },
    data: { publishedHash: finalHash, publishedAt: new Date() },
  });

  return { published: live.length, skipped: false };
}
