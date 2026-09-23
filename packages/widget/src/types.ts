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
  kind: "qty" | "bxgy" | "bundle";
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
  /** Free gifts (progressive gifts already resolved). */
  gifts?: SfGift[];
  /** Before multiple gifts: one gift. */
  gift?: SfGift | null;
  /** Bundle bars: the items; `v: null` is the viewed product. */
  items?: SfBundleItem[];
  upsells: SfUpsell[];
}

export interface SfBundleItem {
  id: string;
  v: number | null;
  q: number;
  dt: DiscountType;
  dv: number;
  title?: string;
  image?: string | null;
  price?: string | null;
}

/** Mix & match pool and chooser settings. */
export interface SfMixMatch {
  tt: TargetType;
  p: number[];
  c: number[];
  /** Product and collection handles, to list the pool's products. */
  ph: string[];
  ch: string[];
  title: string;
  button: string;
  names: boolean;
  photo: number;
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
  titleWeight?: number;
  subtitleSize?: number;
  priceSize?: number;
  blockTitleSize?: number;
  blockTitleWeight?: number;
  borderWidth?: number;
  barGap?: number;
  barPadding?: number;
  variants?: SfVariantStyle;
  giftTrack?: boolean;
  savingsBar?: SfSavingsBar;
  htmlAbove?: string;
  htmlBelow?: string;
  customCss?: string;
  colors?: Record<string, string>;
}

export interface SfSavingsBar {
  enabled: boolean;
  text: string;
  includeGifts: boolean;
  background: string;
  textColor: string;
  valueColor: string;
  border: boolean;
  icon: boolean;
  align: "left" | "center" | "right";
  size: number;
}

export interface SfArm {
  key: string;
  weight?: number;
  bars: SfBar[];
  /** What else the arm changes (merged over the deal). */
  style?: SfStyle;
  variantPerUnit?: boolean;
  showVariantPicker?: boolean;
}

/** A selling plan group of the product (Liquid `product.selling_plan_groups`). */
export interface SfPlanGroup {
  id: string;
  name: string;
  plans: { id: number; name: string }[];
}

/** A variant's price on one selling plan (`variant.selling_plan_allocations`). */
export interface SfAllocation {
  /** Selling plan id. */
  p: number;
  /** Price in presentment cents. */
  price: number;
  /** Compare-at price, when the plan has one. */
  cap: number | null;
}

/** Subscriptions: what the deal does with selling plans. */
export interface SfSubscriptions {
  /** Show the one-time / subscribe picker. */
  on: boolean;
  /** Purchases the deal prices: both, subscription only, one-time only. */
  apply: "b" | "s" | "o";
  one: string;
  sub: string;
  pre: "one" | "sub";
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
  /** Mix & match: shoppers fill the bar's units with products from this pool. */
  mm?: SfMixMatch;
  /** Countries of the deal's markets (missing = everywhere). */
  ctry?: string[];
  /** Subscriptions (Phase 5); missing = one-time and subscription alike, no picker. */
  sub?: SfSubscriptions;
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

/** The widget's own words for this page's language. */
export interface SfStrings {
  each: string;
  soldOut: string;
  unlocked: string;
  buy: string;
  freeGift: string;
  choose: string;
  search: string;
  loading: string;
  noProducts: string;
  close: string;
  addError: string;
}

export const DEFAULT_STRINGS: SfStrings = {
  each: "/ each",
  soldOut: "Sold out",
  unlocked: "Unlocked",
  buy: "Buy {{quantity}}",
  freeGift: "+ FREE gift",
  choose: "Choose",
  search: "Search",
  loading: "Loading…",
  noProducts: "No products found.",
  close: "Close",
  addError: "Could not add to cart",
};

/** One language's texts, published as `cartlift/i18n_<locale>`. */
export interface SfI18n {
  strings?: Partial<SfStrings>;
  deals?: Record<string, SfDealTranslation>;
}

export interface SfDealTranslation {
  blockTitle?: string;
  savingsText?: string;
  modalTitle?: string;
  modalButton?: string;
  onetimeLabel?: string;
  subscribeLabel?: string;
  bars?: Record<string, { title?: string; subtitle?: string; label?: string; badge?: string; giftText?: string; highlights?: string[] }>;
  upsells?: Record<string, string>;
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
  /** The storefront's country (Shopify markets). */
  country?: string;
  /** This page's language, when the merchant translated the deal. */
  i18n?: SfI18n | null;
  /** The product's selling plan groups, for the subscribe picker. */
  sp?: SfPlanGroup[];
  /** Selling plan prices per variant id. */
  spa?: Record<string, SfAllocation[]>;
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
  /** The selling plan the shopper picked; missing / null = one-time. */
  plan?: number | null;
  bars?: SfBar[];
  /** Complementary products, once fetched. */
  complementary?: SfRecommended[];
  /** Mix & match: products chosen for units 2.. of the selected bar. */
  mix?: Record<number, MixPick>;
}

/** A product a shopper picked for a mix & match slot (price in presentment cents). */
export interface MixPick {
  productId: number;
  variantId: number;
  title: string;
  image: string | null;
  price: number;
}

export interface RenderCtx {
  product: SfProduct;
  moneyFormat: string;
  rate: number;
  /** The widget's own words (defaults when the page isn't translated). */
  strings?: SfStrings;
  /** Admin preview: merchant HTML is shown without scripts. */
  preview?: boolean;
  options?: SfOptionSwatches[];
  mf?: Record<string, unknown>;
  /** Selling plans of the product, and each variant's price on them. */
  plans?: SfPlanGroup[];
  alloc?: Record<string, SfAllocation[]>;
}
