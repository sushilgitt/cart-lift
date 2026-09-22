import type { SfProduct, SfVariant } from "./types";

/**
 * Option-based variant picking (Size, Color, …) for the per-unit and
 * single-bar pickers. Pure functions over the product JSON Liquid renders.
 */

/** A variant's option values, from `options` or option1..3. */
export function variantValues(v: SfVariant): string[] {
  if (Array.isArray(v.options)) return v.options.map(String);
  return [v.option1, v.option2, v.option3].filter((o): o is string => o != null).map(String);
}

/** Option names, e.g. ["Size", "Color"]; empty for single-variant products. */
export function optionNames(product: SfProduct): string[] {
  const names = (product.options || []).map((o) => (typeof o === "string" ? o : o.name));
  if (names.length) return names;
  const first = product.variants?.[0];
  return first ? variantValues(first).map((_, i) => `Option ${i + 1}`) : [];
}

/** Values of option `index`, in the order the variants list them. */
export function optionValues(product: SfProduct, index: number): string[] {
  const out: string[] = [];
  for (const v of product.variants || []) {
    const value = variantValues(v)[index];
    if (value != null && !out.includes(value)) out.push(value);
  }
  return out;
}

const sameAs = (values: string[]) => (v: SfVariant) => {
  const own = variantValues(v);
  return values.every((value, i) => own[i] === value);
};

/**
 * The variant after changing option `index` to `value`, keeping the other
 * options where possible: exact match first, then an available variant with
 * that value, then any variant with it.
 */
export function withOption(product: SfProduct, current: SfVariant, index: number, value: string): SfVariant {
  const values = variantValues(current).slice();
  values[index] = value;
  const variants = product.variants || [];
  return (
    variants.find(sameAs(values)) ||
    variants.find((v) => variantValues(v)[index] === value && v.available !== false) ||
    variants.find((v) => variantValues(v)[index] === value) ||
    current
  );
}

/** Whether picking `value` for option `index` (keeping the rest) gives an available variant. */
export function valueAvailable(product: SfProduct, current: SfVariant, index: number, value: string): boolean {
  const values = variantValues(current).slice();
  values[index] = value;
  const exact = (product.variants || []).find(sameAs(values));
  return exact ? exact.available !== false : false;
}

/** Variant image for an option value: the matching variant's featured image. */
export function valueImage(product: SfProduct, current: SfVariant, index: number, value: string): string | null {
  const v = withOption(product, current, index, value);
  const img = v.featured_image;
  if (!img) return null;
  return typeof img === "string" ? img : img.src || null;
}
