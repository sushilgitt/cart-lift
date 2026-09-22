/**
 * Deal shape shared by the editor, the live preview and the publisher.
 *
 * Everything here is client-safe. `Deal.config` in the database is a
 * `DealConfig`; `normalizeConfig` is the one place that fills defaults, so old
 * rows keep working as options are added.
 */

import { priceBar as corePriceBar, type BarPrice } from "../../packages/core/src";

export type DiscountType = "none" | "percentage" | "amount" | "fixed_total";
export type BarKind = "qty" | "bxgy" | "bundle";
export type Layout = "vertical" | "horizontal" | "grid";
export type DealTypeKey = "QUANTITY_BREAK" | "BXGY" | "BUNDLE";
export type TargetTypeKey = "ALL" | "PRODUCTS" | "COLLECTIONS" | "EXCEPT";

export interface ResourceRef {
  /** Admin GID, e.g. gid://shopify/Product/123 */
  id: string;
  title: string;
  image?: string | null;
  /** Storefront handle (products, collections): lets the widget load them. */
  handle?: string;
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
  /** Free gifts, one unit each. With progressive gifts on, bigger bars also get smaller bars' gifts. */
  gifts: VariantRef[];
  giftText: string;
  upsells: Upsell[];
  /** Bundle bars ("complete the bundle"): the viewed product plus hand-picked items. */
  items: BundleItem[];
  /** Image shown on the bar (Shopify Files URL). */
  image: { url: string; alt: string } | null;
  /** Short callouts under the subtitle, e.g. "Free shipping". */
  highlights: string[];
  /** Variants pre-selected per unit (in order); only those of the viewed product apply. */
  defaultVariants: VariantRef[];
  /** BXGY: extra percentage off on top of the free items ("Buy 3 get 4 + 10%"). */
  extraPercent: number;
}

/** An item of a bundle bar. `variant: null` is the product being viewed. */
export interface BundleItem {
  id: string;
  variant: VariantRef | null;
  qty: number;
  discountType: DiscountType;
  discountValue: number;
}

/** Mix & match: which products shoppers can choose to fill a bar. */
export interface MixMatch {
  enabled: boolean;
  /** Products from the deal's own visibility, or a separate pool. */
  pool: "visibility" | "products" | "collections" | "except";
  products: ResourceRef[];
  collections: ResourceRef[];
  modalTitle: string;
  buttonText: string;
  showNames: boolean;
  photoSize: number;
}

export type ArmKey = "A" | "B" | "C" | "D";
export const ARM_KEYS: ArmKey[] = ["A", "B", "C", "D"];

/** What an A/B variant may change: everything but visibility, schedule and mix & match pool. */
export type ArmOverride = Partial<
  Pick<DealConfig, "bars" | "style" | "discountName" | "variantPerUnit" | "showVariantPicker" | "progressiveGifts">
>;

export interface AbTest {
  /** "off": no test. "running": arms are published. "ended": results kept, arm A shown. */
  status: "off" | "running" | "ended";
  /** Traffic split per arm in percent (arms present in `arms`, plus A). */
  weights: Partial<Record<ArmKey, number>>;
  arms: Partial<Record<Exclude<ArmKey, "A">, ArmOverride>>;
  startedAt: string | null;
  endedAt: string | null;
}

export const DEFAULT_AB_TEST: AbTest = { status: "off", weights: { A: 100 }, arms: {}, startedAt: null, endedAt: null };

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
  /** Show every gift tier as a track above the bars (progressive gifts). */
  giftTrack: boolean;
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
  /** A bar also gets the gifts of every smaller bar. */
  progressiveGifts: boolean;
  mixMatch: MixMatch;
  abTest: AbTest;
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
    title: "Mix & match",
    description: "Tiers filled with different products the shopper picks.",
  },
};

export type TemplateKey =
  | "quantity_breaks"
  | "bxgy"
  | "mix_match"
  | "complete_bundle"
  | "progressive_gifts"
  | "subscription";

/** The "Create deal" gallery. A template only seeds the deal; every option stays editable. */
export const TEMPLATES: Record<TemplateKey, { title: string; description: string; type: DealTypeKey; available: boolean }> = {
  quantity_breaks: {
    title: "Quantity breaks for the same product",
    description: "Buy 1, buy 2 save 10%, buy 3 save 20%.",
    type: "QUANTITY_BREAK",
    available: true,
  },
  bxgy: {
    title: "Buy X, get Y",
    description: "BOGO and buy-X-get-Y. Free items show at $0 in checkout.",
    type: "BXGY",
    available: true,
  },
  mix_match: {
    title: "Quantity breaks for different products",
    description: "Shoppers pick products from a pool to fill each tier.",
    type: "BUNDLE",
    available: true,
  },
  complete_bundle: {
    title: "Complete the bundle",
    description: "The product plus hand-picked items, each with its own discount.",
    type: "QUANTITY_BREAK",
    available: true,
  },
  progressive_gifts: {
    title: "Progressive gifts",
    description: "Bigger bundles unlock more free gifts.",
    type: "QUANTITY_BREAK",
    available: true,
  },
  subscription: {
    title: "Subscription",
    description: "Subscribe-and-save bundles. Coming soon.",
    type: "QUANTITY_BREAK",
    available: false,
  },
};

/** A new deal's config from a template. */
export function templateConfig(template: TemplateKey): DealConfig {
  const type = TEMPLATES[template]?.type ?? "QUANTITY_BREAK";
  const config = defaultConfig(type);
  if (template === "mix_match") {
    config.across = true;
    config.mixMatch = { ...DEFAULT_MIX_MATCH, enabled: true };
  } else if (template === "complete_bundle") {
    config.bars = [
      newBar({ qty: 1, title: "Just this", subtitle: "Standard price" }),
      newBundleBar({ selected: true, badge: "Best value" }),
    ];
  } else if (template === "progressive_gifts") {
    config.progressiveGifts = true;
    config.style.giftTrack = true;
    config.bars = [
      newBar({ qty: 1, title: "Buy 1", subtitle: "Standard price" }),
      newBar({ qty: 2, discountType: "percentage", discountValue: 10, title: "Buy 2", subtitle: "+ 1 free gift", selected: true }),
      newBar({ qty: 3, discountType: "percentage", discountValue: 15, title: "Buy 3", subtitle: "+ 2 free gifts", badge: "Best value" }),
    ];
  }
  return config;
}

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
  giftTrack: false,
  colors: DEFAULT_COLORS,
};

export const DEFAULT_MIX_MATCH: MixMatch = {
  enabled: false,
  pool: "visibility",
  products: [],
  collections: [],
  modalTitle: "Choose your products",
  buttonText: "Choose",
  showNames: true,
  photoSize: 64,
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
    gifts: [],
    giftText: "+ FREE gift",
    upsells: [],
    items: [],
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

export function newBundleItem(partial: Partial<BundleItem> = {}): BundleItem {
  return { id: uid("i"), variant: null, qty: 1, discountType: "percentage", discountValue: 0, ...partial };
}

/** A complete-the-bundle bar: the viewed product plus one item to pick. */
export function newBundleBar(partial: Partial<Bar> = {}): Bar {
  return newBar({
    kind: "bundle",
    title: "Complete the set",
    subtitle: "Save {{saved_amount}}",
    items: [newBundleItem(), newBundleItem({ discountType: "percentage", discountValue: 20 })],
    ...partial,
  });
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
    progressiveGifts: false,
    mixMatch: { ...DEFAULT_MIX_MATCH },
    abTest: { ...DEFAULT_AB_TEST, weights: { A: 100 }, arms: {} },
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

const refs = (v: unknown, max = 250): ResourceRef[] =>
  Array.isArray(v)
    ? v
        .filter((r) => r && typeof r.id === "string")
        .slice(0, max)
        .map((r) => ({ id: r.id, title: str(r.title), image: r.image ?? null, ...(r.handle ? { handle: str(r.handle) } : {}) }))
    : [];

function normalizeItems(v: unknown): BundleItem[] {
  if (!Array.isArray(v)) return [];
  return v.slice(0, 6).map((item) =>
    newBundleItem({
      id: str(item?.id) || uid("i"),
      variant: item?.variant?.id ? item.variant : null,
      qty: Math.min(20, Math.max(1, Math.floor(num(item?.qty, 1)))),
      discountType: oneOf(item?.discountType, ["none", "percentage", "amount", "fixed_total"] as const, "none"),
      discountValue: Math.max(0, num(item?.discountValue, 0)),
    }),
  );
}

/** Fields an A/B variant may change. */
export const ARM_FIELDS = ["bars", "style", "discountName", "variantPerUnit", "showVariantPicker", "progressiveGifts"] as const;

function normalizeAbTest(raw: unknown, type: DealTypeKey): AbTest {
  const t = (raw ?? {}) as Partial<AbTest>;
  const arms: AbTest["arms"] = {};
  for (const key of ["B", "C", "D"] as const) {
    const override = t.arms?.[key];
    if (!override || typeof override !== "object") continue;
    // Normalize an arm's fields the same way as the deal's own.
    const full = normalizeConfig({ ...override, bars: override.bars ?? [] }, type);
    const clean: ArmOverride = {};
    for (const field of ARM_FIELDS) if (field in override) (clean as Record<string, unknown>)[field] = full[field];
    arms[key] = clean;
  }
  const keys: ArmKey[] = ["A", ...(Object.keys(arms) as ArmKey[])];
  const weights: AbTest["weights"] = {};
  for (const k of keys) weights[k] = Math.max(0, Math.min(100, num(t.weights?.[k], Math.floor(100 / keys.length))));
  return {
    status: oneOf(t.status, ["off", "running", "ended"] as const, "off"),
    weights,
    arms,
    startedAt: typeof t.startedAt === "string" ? t.startedAt : null,
    endedAt: typeof t.endedAt === "string" ? t.endedAt : null,
  };
}

/** The config shoppers in `arm` get: the deal's own, with the arm's overrides. */
export function armConfig(config: DealConfig, arm: string): DealConfig {
  const override = arm === "A" ? undefined : config.abTest.arms[arm as Exclude<ArmKey, "A">];
  return override ? { ...config, ...override } : config;
}

/** Arms shoppers are split between right now (A alone unless a test runs). */
export function liveArms(config: DealConfig): ArmKey[] {
  if (config.abTest.status !== "running") return ["A"];
  return ["A", ...(Object.keys(config.abTest.arms) as ArmKey[])];
}

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
            // Deals saved before multiple gifts had one `gift`.
            gifts: Array.isArray(b?.gifts)
              ? b.gifts.filter((g) => g?.id).slice(0, 5)
              : (b as unknown as { gift?: VariantRef | null })?.gift?.id
                ? [(b as unknown as { gift: VariantRef }).gift]
                : [],
            items: normalizeItems(b?.items),
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
      giftTrack: Boolean(style.giftTrack),
      colors: { ...DEFAULT_COLORS, ...(style.colors ?? {}) },
    },
    across: Boolean(r.across ?? base.across),
    progressiveGifts: Boolean(r.progressiveGifts),
    mixMatch: {
      ...DEFAULT_MIX_MATCH,
      enabled: Boolean(r.mixMatch?.enabled),
      pool: oneOf(r.mixMatch?.pool, ["visibility", "products", "collections", "except"] as const, "visibility"),
      products: refs(r.mixMatch?.products),
      collections: refs(r.mixMatch?.collections),
      modalTitle: str(r.mixMatch?.modalTitle, DEFAULT_MIX_MATCH.modalTitle),
      buttonText: str(r.mixMatch?.buttonText, DEFAULT_MIX_MATCH.buttonText),
      showNames: r.mixMatch?.showNames == null ? DEFAULT_MIX_MATCH.showNames : Boolean(r.mixMatch.showNames),
      photoSize: Math.min(160, Math.max(32, num(r.mixMatch?.photoSize, DEFAULT_MIX_MATCH.photoSize))),
    },
    abTest: normalizeAbTest(r.abTest, type),
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
    if (bar.kind === "bundle") {
      if (!bar.title.trim()) errors.push(`${n}: add a title.`);
      if (bar.items.filter((it) => !it.variant).length !== 1)
        errors.push(`${n}: a bundle has the viewed product once, plus the items you pick.`);
      if (!bar.items.some((it) => it.variant)) errors.push(`${n}: pick at least one product for the bundle.`);
      if (bar.items.some((it) => it.discountType === "percentage" && it.discountValue > 100))
        errors.push(`${n}: a percentage can't be more than 100.`);
      return;
    }
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
  const ab = config.abTest;
  if (ab.status === "running") {
    const arms = liveArms(config);
    if (arms.length < 2) errors.push("A/B test: add at least one variant to test against A.");
    const total = arms.reduce((sum, k) => sum + (ab.weights[k] ?? 0), 0);
    if (total !== 100) errors.push(`A/B test: the traffic split must add up to 100% (now ${total}%).`);
    for (const k of arms) {
      if (k === "A") continue;
      for (const e of validateConfig({ ...armConfig(config, k), abTest: { ...DEFAULT_AB_TEST } })) errors.push(`Variant ${k}: ${e}`);
    }
  }
  const mm = config.mixMatch;
  if (mm.enabled) {
    if ((mm.pool === "products" || mm.pool === "except") && !mm.products.length)
      errors.push("Mix & match: pick the products shoppers can choose from.");
    if (mm.pool === "collections" && !mm.collections.length)
      errors.push("Mix & match: pick the collections shoppers can choose from.");
  }
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
    // Bundle bars are priced per item (packages/core priceBundle); as a plain bar here.
    { kind: bar.kind === "bxgy" ? "bxgy" : "qty", qty: bar.qty, get: bar.get, dt: bar.discountType, dv: bar.discountValue, xp: bar.extraPercent },
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

const sfVariant = (v: VariantRef) => ({
  id: Number(numericId(v.id)),
  title: v.productTitle || v.title,
  image: v.image ?? null,
  price: v.price ?? null,
});

export function storefrontBar(bar: Bar, config?: DealConfig) {
  const gifts = config ? effectiveGifts(config, bar) : bar.gifts;
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
    gifts: gifts.map((g) => ({ ...sfVariant(g), text: bar.giftText })),
    ...(bar.kind === "bundle"
      ? {
          items: bar.items.map((it) => ({
            id: it.id,
            v: it.variant ? Number(numericId(it.variant.id)) : null,
            q: it.qty,
            dt: it.discountType,
            dv: it.discountValue,
            ...(it.variant ? { title: sfVariant(it.variant).title, image: it.variant.image ?? null, price: it.variant.price ?? null } : {}),
          })),
        }
      : {}),
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

/**
 * A bar's free gifts as shoppers get them: its own, plus — with progressive
 * gifts on — those of every smaller quantity bar, in editor order.
 */
export function effectiveGifts(config: DealConfig, bar: Bar): VariantRef[] {
  if (!config.progressiveGifts || bar.kind === "bundle") return bar.gifts;
  const out: VariantRef[] = [];
  for (const b of config.bars) {
    if (b.kind === "bundle" || b.qty > bar.qty) continue;
    for (const g of b.gifts) if (!out.some((x) => x.id === g.id)) out.push(g);
  }
  return out;
}

/** Mix & match pool as targeting (the deal's own when the pool is "visibility"). */
export function mixMatchPool(config: DealConfig, deal: Pick<DealLike, "targetType" | "products" | "collections">) {
  const mm = config.mixMatch;
  if (!mm.enabled) return null;
  if (mm.pool === "visibility") {
    return { tt: deal.targetType, products: refList(deal.products), collections: refList(deal.collections) };
  }
  const tt: TargetTypeKey = mm.pool === "products" ? "PRODUCTS" : mm.pool === "except" ? "EXCEPT" : "COLLECTIONS";
  return { tt, products: mm.products, collections: mm.collections };
}

/** "namespace.key": how Liquid publishes a metafield's value to the widget. */
export const metafieldKey = (m: MetafieldVar) => `${m.namespace}.${m.key}`;

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
    mfv: config.metafieldVars.map((m) => ({ name: m.name, k: metafieldKey(m) })),
    style: config.style,
    bars: config.bars.map((bar) => storefrontBar(bar, config)),
    ...mixMatchStorefront(config, deal),
    ...abStorefront(config),
  };
}

/** Running A/B test: each arm's weight and what it changes (the widget merges it over the deal). */
function abStorefront(config: DealConfig) {
  const arms = liveArms(config);
  if (arms.length < 2) return {};
  return {
    weightA: config.abTest.weights.A ?? 0,
    arms: arms
      .filter((k) => k !== "A")
      .map((key) => {
        const c = armConfig(config, key);
        return {
          key,
          weight: config.abTest.weights[key] ?? 0,
          bars: c.bars.map((bar) => storefrontBar(bar, c)),
          style: c.style,
          variantPerUnit: c.variantPerUnit,
          showVariantPicker: c.showVariantPicker,
        };
      }),
  };
}

function mixMatchStorefront(config: DealConfig, deal: DealLike) {
  const pool = mixMatchPool(config, deal);
  if (!pool) return {};
  const mm = config.mixMatch;
  return {
    mm: {
      tt: pool.tt,
      p: pool.products.map((p) => Number(numericId(p.id))),
      c: pool.collections.map((c) => Number(numericId(c.id))),
      // Handles let the widget list the pool's products.
      ph: pool.products.map((p) => p.handle).filter(Boolean),
      ch: pool.collections.map((c) => c.handle).filter(Boolean),
      title: mm.modalTitle,
      button: mm.buttonText,
      names: mm.showNames,
      photo: mm.photoSize,
    },
  };
}
