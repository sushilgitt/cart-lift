/**
 * Deal shape shared by the editor, the live preview and the publisher.
 *
 * Everything here is client-safe. `Deal.config` in the database is a
 * `DealConfig`; `normalizeConfig` is the one place that fills defaults, so old
 * rows keep working as options are added.
 */

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
  colors: DealColors;
}

export interface DealConfig {
  bars: Bar[];
  style: DealStyle;
  /** Count units across all eligible products instead of per product. */
  across: boolean;
  /** Pick a different variant for each unit. */
  variantPerUnit: boolean;
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

export const DEFAULT_STYLE: DealStyle = {
  layout: "vertical",
  showBlockTitle: true,
  blockTitle: "BUNDLE & SAVE",
  showUnitPrice: true,
  useCompareAt: false,
  radius: 10,
  titleSize: 15,
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
    ...partial,
  };
}

export function newUpsell(partial: Partial<Upsell> = {}): Upsell {
  return {
    id: uid("u"),
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
    style: { ...DEFAULT_STYLE, colors: { ...DEFAULT_COLORS } },
    across: type === "BUNDLE",
    variantPerUnit: false,
    discountName: "",
  };
}

const num = (v: unknown, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const str = (v: unknown, d = "") => (typeof v === "string" ? v : d);

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
            upsells: Array.isArray(b?.upsells) ? b.upsells.map((u) => newUpsell(u)) : [],
          }),
        )
      : base.bars,
    style: {
      ...DEFAULT_STYLE,
      ...style,
      radius: num(style.radius, DEFAULT_STYLE.radius),
      titleSize: num(style.titleSize, DEFAULT_STYLE.titleSize),
      colors: { ...DEFAULT_COLORS, ...(style.colors ?? {}) },
    },
    across: Boolean(r.across ?? base.across),
    variantPerUnit: Boolean(r.variantPerUnit),
    discountName: str(r.discountName),
  };
}

/** Validation errors that should block saving. */
export function validateConfig(config: DealConfig): string[] {
  const errors: string[] = [];
  if (!config.bars.length) errors.push("Add at least one bar.");
  const seen = new Set<number>();
  config.bars.forEach((bar, i) => {
    const n = `Bar ${i + 1}`;
    if (seen.has(bar.qty)) errors.push(`${n}: quantity ${bar.qty} is used by another bar.`);
    seen.add(bar.qty);
    if (bar.kind === "bxgy" && (bar.get < 1 || bar.get >= bar.qty))
      errors.push(`${n}: "get" must be at least 1 and less than the total quantity.`);
    if (bar.discountType === "percentage" && bar.discountValue > 100)
      errors.push(`${n}: a percentage can't be more than 100.`);
    if (!bar.title.trim()) errors.push(`${n}: add a title.`);
  });
  if (config.bars.filter((b) => b.selected).length > 1)
    errors.push("Only one bar can be selected by default.");
  return errors;
}

// ---------------------------------------------------------------------------
// Pricing (mirrors extensions/cartlift-widget/assets/cartlift.js)
// ---------------------------------------------------------------------------

export interface BarPrice {
  /** What the shopper pays for the bar, in cents. */
  total: number;
  /** Price without the deal, in cents. */
  full: number;
  saved: number;
  savedPct: number;
  unit: number;
}

/** Prices a bar for a unit price in cents. `rate` converts shop-currency amounts. */
export function priceBar(
  bar: Pick<Bar, "kind" | "qty" | "get" | "discountType" | "discountValue">,
  unitCents: number,
  compareCents = 0,
  rate = 1,
): BarPrice {
  const qty = Math.max(1, bar.qty);
  const base = unitCents * qty;
  let total = base;
  const v = Math.max(0, bar.discountValue);

  if (bar.kind === "bxgy") {
    const get = Math.min(bar.get, qty - 1);
    const each =
      bar.discountType === "percentage" || bar.discountType === "none"
        ? unitCents * (bar.discountType === "none" ? 1 : Math.min(v, 100) / 100)
        : bar.discountType === "amount"
          ? Math.min(v * 100 * rate, unitCents)
          : Math.max(0, unitCents - v * 100 * rate);
    total = base - each * Math.max(0, get);
  } else if (bar.discountType === "percentage") {
    total = base * (1 - Math.min(v, 100) / 100);
  } else if (bar.discountType === "amount") {
    total = Math.max(0, base - v * 100 * rate * qty);
  } else if (bar.discountType === "fixed_total") {
    total = Math.min(base, v * 100 * rate);
  }

  total = Math.round(total);
  const full = Math.max(base, compareCents > unitCents ? compareCents * qty : base);
  const saved = Math.max(0, full - total);
  return {
    total,
    full,
    saved,
    savedPct: full > 0 ? Math.round((saved / full) * 100) : 0,
    unit: Math.round(total / qty),
  };
}

export function formatMoney(cents: number, format = "${{amount}}"): string {
  const amount = (cents / 100).toFixed(2);
  const [whole, dec] = amount.split(".");
  const withCommas = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return format.replace(/\{\{\s*(\w+)\s*\}\}/, (_m, key: string) => {
    switch (key) {
      case "amount_no_decimals":
        return withCommas;
      case "amount_with_comma_separator":
        return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${dec}`;
      case "amount_no_decimals_with_comma_separator":
        return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
      default:
        return `${withCommas}.${dec}`;
    }
  });
}

export function renderText(
  text: string,
  vars: Record<string, string | number>,
): string {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key: string) =>
    key in vars ? String(vars[key]) : m,
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
      .filter((u) => u.variant)
      .map((u) => ({
        id: u.id,
        variant: Number(numericId(u.variant!.id)),
        title: u.variant!.productTitle || u.variant!.title,
        image: u.variant!.image ?? null,
        price: u.variant!.price ?? null,
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
    style: config.style,
    bars: config.bars.map(storefrontBar),
  };
}
