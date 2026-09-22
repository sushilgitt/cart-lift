import type { DiscountType, TargetType } from "../../core/src";

/** Storefront shapes published by app/lib/deals.ts → storefrontDeal / buildStorefrontConfig. */

export interface SfGift {
  id: number;
  title: string;
  image: string | null;
  price: string | null;
  text: string;
}

export interface SfUpsell {
  id: string;
  /** "product" (the picked variant) or "complementary" (Search & Discovery). Missing = product. */
  source?: "product" | "complementary";
  /** Complementary: how many products to offer. */
  limit?: number;
  variant: number;
  title: string;
  image: string | null;
  price: string | null;
  text: string;
  dt: DiscountType;
  dv: number;
  checked: boolean;
  onlyWhenSelected: boolean;
}

export interface SfBar {
  id: string;
  kind: "qty" | "bxgy";
  qty: number;
  get: number;
  dt: DiscountType;
  dv: number;
  /** BXGY extra percentage. */
  xp?: number;
  title: string;
  subtitle: string;
  label: string;
  badge: string;
  badgeStyle: "simple" | "fancy";
  selected: boolean;
  image?: { url: string; alt: string } | null;
  highlights?: string[];
  /** Default variant ids per unit. */
  dvar?: number[];
  gift: SfGift | null;
  upsells: SfUpsell[];
}

export interface SfVariantStyle {
  display?: "dropdown" | "swatch";
  source?: "color" | "image" | "variant_image";
  shape?: "circle" | "rounded" | "square";
  size?: number;
}

export interface SfStyle {
  layout?: string;
  showBlockTitle?: boolean;
  blockTitle?: string;
  showUnitPrice?: boolean;
  useCompareAt?: boolean;
  radius?: number;
  titleSize?: number;
  imageSize?: number;
  variants?: SfVariantStyle;
  colors?: Record<string, string>;
}

export interface SfArm {
  key: string;
  weight?: number;
  bars: SfBar[];
}

export interface SfDeal {
  id: string;
  name: string;
  type: string;
  tt: TargetType;
  p: number[];
  c: number[];
  s: string | null;
  e: string | null;
  across: boolean;
  variantPerUnit: boolean;
  /** Variant picker on single-quantity bars. */
  showVariantPicker?: boolean;
  /** Metafield text variables: `{{name}}` ← value of metafield `k` ("namespace.key"). */
  mfv?: { name: string; k: string }[];
  style: SfStyle;
  bars: SfBar[];
  /** A/B arms (Phase 3). */
  arms?: SfArm[];
  weightA?: number;
}

export interface SfConfig {
  v: number;
  api: string;
  css: string;
  /** Metafields Liquid renders for the product ("namespace.key"). */
  mf?: { k: string; ns: string; key: string }[];
  deals: SfDeal[];
}

export interface SfVariant {
  id: number | string;
  title: string;
  price: number;
  compare_at_price: number | null;
  available?: boolean;
  options?: string[];
  option1?: string | null;
  option2?: string | null;
  option3?: string | null;
  featured_image?: { src?: string } | string | null;
}

export interface SfProduct {
  id: number | string;
  title?: string;
  handle?: string;
  options?: (string | { name: string })[];
  variants: SfVariant[];
}

/** Swatch data per option value (Liquid `options_with_values[].values[].swatch`). */
export interface SfOptionSwatches {
  name: string;
  values: { name: string; color: string | null; image: string | null }[];
}

/** One `script[data-cartlift-data]` block (snippets/cartlift-data.liquid). */
export interface SfData {
  config: SfConfig;
  product: SfProduct;
  collections: number[];
  /** Option swatches. */
  options?: SfOptionSwatches[];
  /** Metafield values by "namespace.key". */
  mf?: Record<string, unknown>;
  moneyFormat: string;
  shop: string;
  placement: "auto" | "block";
}

/** A product from /recommendations/products.json (prices in presentment cents). */
export interface SfRecommended {
  id: number;
  title: string;
  featured_image?: string | null;
  variants: { id: number; price: number; available: boolean; featured_image?: { src?: string } | null }[];
}

export interface RenderState {
  barId: string | undefined;
  variantId: number | string | undefined;
  unitVariants: (number | string)[];
  upsells: Record<string, boolean>;
  bars?: SfBar[];
  /** Complementary products, once fetched. */
  complementary?: SfRecommended[];
}

export interface RenderCtx {
  product: SfProduct;
  moneyFormat: string;
  rate: number;
  options?: SfOptionSwatches[];
  mf?: Record<string, unknown>;
}
