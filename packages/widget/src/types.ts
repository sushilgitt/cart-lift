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
  title: string;
  subtitle: string;
  label: string;
  badge: string;
  badgeStyle: "simple" | "fancy";
  selected: boolean;
  gift: SfGift | null;
  upsells: SfUpsell[];
}

export interface SfStyle {
  layout?: string;
  showBlockTitle?: boolean;
  blockTitle?: string;
  showUnitPrice?: boolean;
  useCompareAt?: boolean;
  radius?: number;
  titleSize?: number;
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
  deals: SfDeal[];
}

export interface SfVariant {
  id: number | string;
  title: string;
  price: number;
  compare_at_price: number | null;
  available?: boolean;
}

export interface SfProduct {
  id: number | string;
  title?: string;
  variants: SfVariant[];
}

/** One `script[data-cartlift-data]` block (snippets/cartlift-data.liquid). */
export interface SfData {
  config: SfConfig;
  product: SfProduct;
  collections: number[];
  moneyFormat: string;
  shop: string;
  placement: "auto" | "block";
}

export interface RenderState {
  barId: string | undefined;
  variantId: number | string | undefined;
  unitVariants: (number | string)[];
  upsells: Record<string, boolean>;
  bars?: SfBar[];
}

export interface RenderCtx {
  product: SfProduct;
  moneyFormat: string;
  rate: number;
}
