/**
 * Deal shape shared by the editor, the live preview and the publisher.
 *
 * Everything here is client-safe. `Deal.config` in the database is a
 * `DealConfig`; `normalizeConfig` is the one place that fills defaults, so old
 * rows keep working as options are added.
 */

import { priceBar as corePriceBar, type BarPrice } from "../../packages/core/src";

export type DiscountType = "none" | "percentage" | "amount" | "fixed_total";
export type BarKind = "qty" | "bxgy";
export type Layout = "vertical" | "horizontal" | "grid";
export type DealTypeKey = "QUANTITY_BREAK" | "BXGY" | "BUNDLE";
export type TargetTypeKey = "ALL" | "PRODUCTS" | "COLLECTIONS" | "EXCEPT";

export interface ResourceRef {
  /** Admin GID, e.g. gid://shopify/Product/123 */
  id: string;
  title: string;
  image?: string | null;
}

export interface VariantRef extends ResourceRef {
  productId: string;
  productTitle?: string;
  price?: string | null;
}

export interface Upsell {
  id: string;
  /** "product": the picked variant. "complementary": Shopify's complementary products (Search & Discovery). */
  source: "product" | "complementary";
  /** Complementary: how many products to offer. */
  limit: number;
  variant: VariantRef | null;
  text: string;
  discountType: DiscountType;
  discountValue: number;
  checked: boolean;
  onlyWhenSelected: boolean;
}

export interface Bar {
  id: string;
  kind: BarKind;
  /** Units in the bar. For BXGY: buy + get. */
  qty: number;
  /** BXGY: discounted units per set. */
  get: number;
  discountType: DiscountType;
  discountValue: number;
  title: string;
  subtitle: string;
  label: string;
  badge: string;
  badgeStyle: "simple" | "fancy";
  selected: boolean;
  gift: VariantRef | null;
  giftText: string;
  upsells: Upsell[];
  /** Image shown on the bar (Shopify Files URL). */
  image: { url: string; alt: string } | null;
  /** Short callouts under the subtitle, e.g. "Free shipping". */
  highlights: string[];
  /** Variants pre-selected per unit (in order); only those of the viewed product apply. */
  defaultVariants: VariantRef[];
  /** BXGY: extra percentage off on top of the free items ("Buy 3 get 4 + 10%"). */
  extraPercent: number;
}

export type VariantDisplay = "dropdown" | "swatch";
export type SwatchSource = "color" | "image" | "variant_image";
export type SwatchShape = "circle" | "rounded" | "square";

export interface VariantStyle {
  display: VariantDisplay;
  source: SwatchSource;
  shape: SwatchShape;
  /** Swatch size in px. */
  size: number;
}

/** A `{{name}}` text variable filled from a product metafield. */
export interface MetafieldVar {
  name: string;
  namespace: string;
  key: string;
}

export interface DealColors {
  accent: string;
  barBg: string;
  barSelectedBg: string;
  border: string;
  borderSelected: string;
  title: string;
  subtitle: string;
  price: string;
  fullPrice: string;
  labelBg: string;
  labelText: string;
  badgeBg: string;
  badgeText: string;
  blockTitle: string;
}

export interface DealStyle {
  layout: Layout;
  showBlockTitle: boolean;
  blockTitle: string;
  showUnitPrice: boolean;
  useCompareAt: boolean;
  radius: number;
  titleSize: number;
  /** Bar image size in px. */
  imageSize: number;
  variants: VariantStyle;
  colors: DealColors;
}

export interface DealConfig {
  bars: Bar[];
  style: DealStyle;
  /** Count units across all eligible products instead of per product. */
  across: boolean;
  /** Pick a different variant for each unit. */
  variantPerUnit: boolean;
  /** Show a variant picker on single-quantity bars (off = the theme's picker is used). */
  showVariantPicker: boolean;
  /** Up to 4 text variables filled from product metafields. */
  metafieldVars: MetafieldVar[];
  /** Discount name in cart/checkout; empty = bar title. */
  discountName: string;
}

export const DISCOUNT_LABELS: Record<DiscountType, string> = {
  none: "No discount",
  percentage: "Percentage off each item",
  amount: "Amount off each item",
  fixed_total: "Fixed total price",
};

export const TEMPLATE_INFO: Record<
  DealTypeKey,
  { title: string; description: string }
> = {
  QUANTITY_BREAK: {
    title: "Quantity breaks",
    description: "Buy 1, buy 2 save 10%, buy 3 save 20% — tiers for the same product.",
  },
  BXGY: {
    title: "Buy X, get Y",
    description: "BOGO and buy-X-get-Y deals. Free items show at $0 in checkout.",
  },
  BUNDLE: {
    title: "Mix & match volume",
    description: "Tiers counted across different products or a whole collection.",
  },
};

export const DEFAULT_COLORS: DealColors = {
  accent: "#1a1a1a",
  barBg: "#ffffff",
  barSelectedBg: "#f4f6f8",
  border: "#d9d9d9",
  borderSelected: "#1a1a1a",
  title: "#1a1a1a",
  subtitle: "#6b7280",
  price: "#1a1a1a",
  fullPrice: "#9ca3af",
  labelBg: "#e7f5ec",
  labelText: "#0f7a3a",
  badgeBg: "#1a1a1a",
  badgeText: "#ffffff",
  blockTitle: "#1a1a1a",
};

export const DEFAULT_VARIANT_STYLE: VariantStyle = { display: "dropdown", source: "color", shape: "circle", size: 28 };

export const DEFAULT_STYLE: DealStyle = {
  layout: "vertical",
  showBlockTitle: true,
  blockTitle: "BUNDLE & SAVE",
  showUnitPrice: true,
  useCompareAt: false,
  radius: 10,
  titleSize: 15,
  imageSize: 56,
  variants: DEFAULT_VARIANT_STYLE,
  colors: DEFAULT_COLORS,
};

let counter = 0;
export function uid(prefix = "b"): string {
  counter += 1;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

export function newBar(partial: Partial<Bar> = {}): Bar {
  return {
    id: uid("b"),
    kind: "qty",
    qty: 1,
    get: 0,
    discountType: "none",
    discountValue: 0,
    title: "",
    subtitle: "",
    label: "",
    badge: "",
    badgeStyle: "simple",
    selected: false,
    gift: null,
    giftText: "+ FREE gift",
    upsells: [],
    image: null,
    highlights: [],
    defaultVariants: [],
    extraPercent: 0,
    ...partial,
  };
}

export function newUpsell(partial: Partial<Upsell> = {}): Upsell {
  return {
    id: uid("u"),
    source: "product",
    limit: 1,
    variant: null,
    text: "Add {{product}} for {{price}}",
    discountType: "percentage",
    discountValue: 20,
    checked: false,
    onlyWhenSelected: false,
    ...partial,
  };
}

export function templateBars(type: DealTypeKey): Bar[] {
  if (type === "BXGY") {
    return [
      newBar({ qty: 1, title: "Buy 1", subtitle: "Standard price" }),
      newBar({
        kind: "bxgy",
        qty: 2,
        get: 1,
        discountType: "percentage",
        discountValue: 100,
        title: "Buy 1, get 1 FREE",
        subtitle: "You save {{saved_amount}}",
        badge: "Most popular",
        selected: true,
      }),
      newBar({
        kind: "bxgy",
        qty: 4,
        get: 2,
        discountType: "percentage",
        discountValue: 100,
        title: "Buy 2, get 2 FREE",
        subtitle: "You save {{saved_amount}}",
        label: "BEST VALUE",
      }),
    ];
  }
  return [
    newBar({ qty: 1, title: "Single", subtitle: "Standard price" }),
    newBar({
      qty: 2,
      discountType: "percentage",
      discountValue: 10,
      title: "Duo",
      subtitle: "You save {{saved_percentage}}",
      badge: "Most popular",
      selected: true,
    }),
    newBar({
      qty: 3,
      discountType: "percentage",
      discountValue: 20,
      title: "Trio",
      subtitle: "You save {{saved_percentage}}",
      label: "SAVE {{saved_amount}}",
    }),
  ];
}

export function defaultConfig(type: DealTypeKey): DealConfig {
  return {
    bars: templateBars(type),
    style: { ...DEFAULT_STYLE, variants: { ...DEFAULT_VARIANT_STYLE }, colors: { ...DEFAULT_COLORS } },
    across: type === "BUNDLE",
    variantPerUnit: false,
    showVariantPicker: true,
    metafieldVars: [],
    discountName: "",
  };
}

const num = (v: unknown, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const str = (v: unknown, d = "") => (typeof v === "string" ? v : d);
const oneOf = <T extends string>(v: unknown, options: readonly T[], d: T): T =>
  options.includes(v as T) ? (v as T) : d;
const strings = (v: unknown, max: number) =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, max) : [];

function normalizeImage(v: unknown): Bar["image"] {
  const img = v as { url?: unknown; alt?: unknown } | null;
  const url = str(img?.url);
  return /^https:\/\//.test(url) ? { url, alt: str(img?.alt) } : null;
}

export function normalizeConfig(raw: unknown, type: DealTypeKey = "QUANTITY_BREAK"): DealConfig {
  const base = defaultConfig(type);
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Partial<DealConfig>;
  const style = (r.style ?? {}) as Partial<DealStyle>;
  return {
    bars: Array.isArray(r.bars)
      ? r.bars.map((b) =>
          newBar({
            ...b,
            id: str(b?.id) || uid("b"),
            qty: Math.max(1, Math.floor(num(b?.qty, 1))),
            get: Math.max(0, Math.floor(num(b?.get, 0))),
            discountValue: Math.max(0, num(b?.discountValue, 0)),
            upsells: Array.isArray(b?.upsells)
              ? b.upsells.map((u) =>
                  newUpsell({
                    ...u,
                    source: oneOf(u?.source, ["product", "complementary"] as const, "product"),
                    limit: Math.min(4, Math.max(1, Math.floor(num(u?.limit, 1)))),
                  }),
                )
              : [],
            image: normalizeImage(b?.image),
            highlights: strings(b?.highlights, 4),
            defaultVariants: Array.isArray(b?.defaultVariants) ? b.defaultVariants.filter((v) => v?.id).slice(0, 20) : [],
            extraPercent: Math.min(100, Math.max(0, num(b?.extraPercent, 0))),
          }),
        )
      : base.bars,
    style: {
      ...DEFAULT_STYLE,
      ...style,
      radius: num(style.radius, DEFAULT_STYLE.radius),
      titleSize: num(style.titleSize, DEFAULT_STYLE.titleSize),
      imageSize: Math.min(160, Math.max(24, num(style.imageSize, DEFAULT_STYLE.imageSize))),
      variants: {
        display: oneOf(style.variants?.display, ["dropdown", "swatch"] as const, DEFAULT_VARIANT_STYLE.display),
        source: oneOf(style.variants?.source, ["color", "image", "variant_image"] as const, DEFAULT_VARIANT_STYLE.source),
        shape: oneOf(style.variants?.shape, ["circle", "rounded", "square"] as const, DEFAULT_VARIANT_STYLE.shape),
        size: Math.min(64, Math.max(16, num(style.variants?.size, DEFAULT_VARIANT_STYLE.size))),
      },
      colors: { ...DEFAULT_COLORS, ...(style.colors ?? {}) },
    },
    across: Boolean(r.across ?? base.across),
    variantPerUnit: Boolean(r.variantPerUnit),
    // Deals saved before this option existed keep the theme's picker.
    showVariantPicker: Boolean(r.showVariantPicker ?? false),
    metafieldVars: Array.isArray(r.metafieldVars)
      ? r.metafieldVars
          .map((m) => ({ name: str(m?.name).trim(), namespace: str(m?.namespace).trim(), key: str(m?.key).trim() }))
          .slice(0, 4)
      : [],
    discountName: str(r.discountName),
  };
}

/** Variables every text field can use (see packages/widget/src/render.ts). */
export const BUILT_IN_VARIABLES = [
  "quantity", "buy", "get", "price", "full_price", "compare_price", "unit_price",
  "saved_amount", "saved_percentage", "discount", "product",
];

const sameDiscount = (a: Bar, b: Bar) =>
  a.kind === b.kind &&
  a.discountType === b.discountType &&
  a.discountValue === b.discountValue &&
  (a.kind !== "bxgy" || a.get === b.get);

/** Validation errors that should block saving. */
export function validateConfig(config: DealConfig): string[] {
  const errors: string[] = [];
  if (!config.bars.length) errors.push("Add at least one bar.");
  // Bars may share a quantity (e.g. "2-pack" and "2-pack + gift"), but checkout
  // prices by quantity, so they must give the same discount.
  const byQty = new Map<number, Bar>();
  config.bars.forEach((bar, i) => {
    const n = `Bar ${i + 1}`;
    const same = byQty.get(bar.qty);
    if (same && !sameDiscount(same, bar))
      errors.push(`${n}: discounts must be the same for the same quantity (${bar.qty}).`);
    if (!same) byQty.set(bar.qty, bar);
    if (bar.kind === "bxgy" && (bar.get < 1 || bar.get >= bar.qty))
      errors.push(`${n}: "get" must be at least 1 and less than the total quantity.`);
    if (bar.discountType === "percentage" && bar.discountValue > 100)
      errors.push(`${n}: a percentage can't be more than 100.`);
    if (!bar.title.trim()) errors.push(`${n}: add a title.`);
  });
  if (config.bars.filter((b) => b.selected).length > 1)
    errors.push("Only one bar can be selected by default.");
  config.bars.forEach((bar, i) => {
    if (bar.upsells.some((u) => u.source === "product" && !u.variant))
      errors.push(`Bar ${i + 1}: pick a product for each upsell.`);
  });
  const names = new Set<string>();
  config.metafieldVars.forEach((m, i) => {
    const n = `Metafield variable ${i + 1}`;
    if (!/^[a-z][a-z0-9_]*$/.test(m.name)) errors.push(`${n}: the name must be lowercase letters, digits or _.`);
    else if (BUILT_IN_VARIABLES.includes(m.name) || names.has(m.name)) errors.push(`${n}: {{${m.name}}} is already used.`);
    names.add(m.name);
    if (!m.namespace || !m.key) errors.push(`${n}: enter the metafield namespace and key.`);
  });
  return errors;
}

// ---------------------------------------------------------------------------
// Pricing — shared with the widget and the Function (packages/core)
// ---------------------------------------------------------------------------

export { formatMoney, renderText, type BarPrice } from "../../packages/core/src";

/** Prices an editor bar for a unit price in cents. `rate` converts shop-currency amounts. */
export function priceBar(
  bar: Pick<Bar, "kind" | "qty" | "get" | "discountType" | "discountValue"> & Partial<Pick<Bar, "extraPercent">>,
  unitCents: number,
  compareCents = 0,
  rate = 1,
): BarPrice {
  return corePriceBar(
    { kind: bar.kind, qty: bar.qty, get: bar.get, dt: bar.discountType, dv: bar.discountValue, xp: bar.extraPercent },
    unitCents,
    compareCents,
    rate,
  );
}

// ---------------------------------------------------------------------------
// Storefront shape (consumed by extensions/cartlift-widget/assets/cartlift.js)
// ---------------------------------------------------------------------------

export const numericId = (gid: string) => gid.split("/").pop() ?? gid;

export interface DealLike {
  id: string;
  name: string;
  type: DealTypeKey;
  targetType: TargetTypeKey;
  products: unknown;
  collections: unknown;
  startsAt: Date | string | null;
  endsAt: Date | string | null;
  config: unknown;
}

const refList = (value: unknown): ResourceRef[] =>
  Array.isArray(value) ? (value as ResourceRef[]).filter((r) => r && r.id) : [];

const iso = (d: Date | string | null) =>
  d ? (typeof d === "string" ? new Date(d).toISOString() : d.toISOString()) : null;

export function storefrontBar(bar: Bar) {
  return {
    id: bar.id,
    kind: bar.kind,
    qty: bar.qty,
    get: bar.get,
    dt: bar.discountType,
    dv: bar.discountValue,
    title: bar.title,
    subtitle: bar.subtitle,
    label: bar.label,
    badge: bar.badge,
    badgeStyle: bar.badgeStyle,
    selected: bar.selected,
    xp: bar.kind === "bxgy" ? bar.extraPercent : 0,
    image: bar.image,
    highlights: bar.highlights.filter((h) => h.trim()),
    dvar: bar.defaultVariants.map((v) => Number(numericId(v.id))),
    gift: bar.gift
      ? {
          id: Number(numericId(bar.gift.id)),
          title: bar.gift.productTitle || bar.gift.title,
          image: bar.gift.image ?? null,
          price: bar.gift.price ?? null,
          text: bar.giftText,
        }
      : null,
    upsells: bar.upsells
      .filter((u) => u.source === "complementary" || u.variant)
      .map((u) => ({
        id: u.id,
        source: u.source,
        limit: u.limit,
        variant: u.variant ? Number(numericId(u.variant.id)) : 0,
        title: u.variant ? u.variant.productTitle || u.variant.title : "",
        image: u.variant?.image ?? null,
        price: u.variant?.price ?? null,
        text: u.text,
        dt: u.discountType,
        dv: u.discountValue,
        checked: u.checked,
        onlyWhenSelected: u.onlyWhenSelected,
      })),
  };
}

export function storefrontDeal(deal: DealLike) {
  const config = normalizeConfig(deal.config, deal.type);
  return {
    id: deal.id,
    name: deal.name,
    type: deal.type,
    tt: deal.targetType,
    p: refList(deal.products).map((p) => Number(numericId(p.id))),
    c: refList(deal.collections).map((c) => Number(numericId(c.id))),
    s: iso(deal.startsAt),
    e: iso(deal.endsAt),
    across: config.across,
    variantPerUnit: config.variantPerUnit,
    showVariantPicker: config.showVariantPicker,
    mfv: config.metafieldVars.map((m) => m.name),
    style: config.style,
    bars: config.bars.map(storefrontBar),
  };
}
