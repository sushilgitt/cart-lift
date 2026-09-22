import { escapeHtml as esc, formatMoney, moneyToCents, priceBar, renderText } from "../../core/src";
import type { RenderCtx, RenderState, SfBar, SfDeal, SfProduct, SfStyle, SfVariant } from "./types";
import { optionNames, optionValues, valueAvailable, valueImage, variantValues } from "./variants";

/** Renders deal bars to HTML. Shared by the storefront and the admin live preview. */

const text = (value: string, vars: Record<string, string | number>) => renderText(value, vars, esc);

const has = (obj: object, key: string) => Object.prototype.hasOwnProperty.call(obj, key);

/** Only plain CSS values: no quotes, semicolons or braces can break out. */
const safeCss = (v: unknown) => v != null && v !== "" && /^[#\w\s(),.%-]+$/.test(String(v));

function styleVars(style: SfStyle): string {
  const c = style.colors || {};
  const map: Record<string, string | null | undefined> = {
    "--cl-accent": c.accent,
    "--cl-bar-bg": c.barBg,
    "--cl-bar-selected-bg": c.barSelectedBg,
    "--cl-border": c.border,
    "--cl-border-selected": c.borderSelected,
    "--cl-title": c.title,
    "--cl-subtitle": c.subtitle,
    "--cl-price": c.price,
    "--cl-full-price": c.fullPrice,
    "--cl-label-bg": c.labelBg,
    "--cl-label-text": c.labelText,
    "--cl-badge-bg": c.badgeBg,
    "--cl-badge-text": c.badgeText,
    "--cl-block-title": c.blockTitle,
    "--cl-radius": style.radius != null ? style.radius + "px" : null,
    "--cl-title-size": style.titleSize ? style.titleSize + "px" : null,
    "--cl-img-size": style.imageSize ? style.imageSize + "px" : null,
    "--cl-swatch-size": style.variants?.size ? style.variants.size + "px" : null,
  };
  let out = "";
  for (const k in map) if (safeCss(map[k])) out += k + ":" + map[k] + ";";
  return out;
}

const cssUrl = (url: string) => "url('" + esc(url).replace(/'/g, "%27") + "')";

export function initialBar(bars: SfBar[]): string | undefined {
  return (bars.find((b) => b.selected) || bars[0])?.id;
}

/** Default variant ids for a bar's units, limited to available variants of this product. */
export function defaultUnits(bar: SfBar | undefined, product: SfProduct): (number | string)[] {
  if (!bar?.dvar?.length) return [];
  const own = new Map((product.variants || []).map((v) => [String(v.id), v]));
  return bar.dvar.filter((id) => own.get(String(id))?.available !== false && own.has(String(id))).slice(0, bar.qty);
}

/** Whether the selected bar shows variant pickers, and how many rows. */
export function pickerRows(deal: SfDeal, bar: SfBar, product: SfProduct): number {
  if ((product.variants || []).length < 2) return 0;
  if (deal.variantPerUnit) return bar.qty;
  if (deal.showVariantPicker && bar.qty === 1) return 1;
  return 0;
}

/** A concrete upsell row: a picked product, or one complementary product. */
export interface UpsellEntry {
  /** Checkbox key: the upsell id, or `id:productId` for complementary products. */
  key: string;
  upsellId: string;
  variant: number;
  title: string;
  image: string | null;
  /** Full price in presentment cents. */
  full: number;
  text: string;
  dt: SfBar["upsells"][number]["dt"];
  dv: number;
  checked: boolean;
  onlyWhenSelected: boolean;
}

export function upsellEntries(bar: SfBar, state: RenderState, ctx: RenderCtx): UpsellEntry[] {
  const out: UpsellEntry[] = [];
  for (const up of bar.upsells || []) {
    if (up.source === "complementary") {
      const products = (state.complementary || []).filter((p) => String(p.id) !== String(ctx.product.id));
      let n = 0;
      for (const p of products) {
        if (n >= Math.max(1, up.limit || 1)) break;
        const v = p.variants.find((x) => x.available);
        if (!v) continue;
        n++;
        out.push({
          key: up.id + ":" + p.id,
          upsellId: up.id,
          variant: v.id,
          title: p.title,
          image: v.featured_image?.src || p.featured_image || null,
          full: Math.round(Number(v.price) || 0),
          text: up.text,
          dt: up.dt,
          dv: up.dv,
          checked: up.checked,
          onlyWhenSelected: up.onlyWhenSelected,
        });
      }
    } else if (up.variant) {
      out.push({
        key: up.id,
        upsellId: up.id,
        variant: up.variant,
        title: up.title,
        image: up.image,
        full: moneyToCents(up.price, ctx.rate),
        text: up.text,
        dt: up.dt,
        dv: up.dv,
        checked: up.checked,
        onlyWhenSelected: up.onlyWhenSelected,
      });
    }
  }
  return out;
}

/** Whether an upsell row is ticked. */
export const upsellOn = (entry: UpsellEntry, state: RenderState) =>
  state.upsells && has(state.upsells, entry.key) ? state.upsells[entry.key] : entry.checked;

function discountText(bar: SfBar, fmt: (c: number) => string, rate: number): string {
  const dv = Math.max(0, Number(bar.dv) || 0);
  if (bar.dt === "percentage") return dv + "%";
  if (bar.dt === "amount" || bar.dt === "fixed_total") return fmt(dv * 100 * rate);
  return "";
}

function renderPickers(
  deal: SfDeal,
  bar: SfBar,
  rows: number,
  state: RenderState,
  ctx: RenderCtx,
  fallback: SfVariant,
): string {
  const product = ctx.product;
  const variants = product.variants || [];
  const names = optionNames(product);
  const look = deal.style?.variants || {};
  const swatch = look.display === "swatch";
  const shape = look.shape === "square" || look.shape === "rounded" ? look.shape : "circle";
  let html = '<div class="cl-variants">';
  for (let i = 0; i < rows; i++) {
    const chosenId = (state.unitVariants && state.unitVariants[i]) || fallback.id;
    const current = variants.find((v) => String(v.id) === String(chosenId)) || fallback;
    const values = variantValues(current);
    html += '<div class="cl-variant-row">' + (rows > 1 ? '<span class="cl-unit-no">#' + (i + 1) + "</span>" : "");
    names.forEach((name, j) => {
      const choices = optionValues(product, j);
      if (swatch) {
        const swatches = ctx.options?.[j]?.values || [];
        html += '<div class="cl-swatches" role="radiogroup" aria-label="' + esc(name) + '">';
        choices.forEach((value) => {
          const data = swatches.find((s) => s.name === value);
          let bg = "";
          if (look.source === "variant_image") {
            const img = valueImage(product, current, j, value);
            if (img) bg = "background-image:" + cssUrl(img);
          } else if (look.source === "image" && data?.image) {
            bg = "background-image:" + cssUrl(data.image);
          } else if (data?.color && safeCss(data.color)) {
            bg = "background-color:" + data.color;
          }
          const on = values[j] === value;
          const ok = valueAvailable(product, current, j, value);
          html +=
            '<button type="button" class="cl-swatch cl-swatch--' + shape + (bg ? "" : " cl-swatch--text") +
            (on ? " is-selected" : "") + (ok ? "" : " is-unavailable") + '" data-unit="' + i + '" data-opt="' + j +
            '" data-val="' + esc(value) + '" role="radio" aria-checked="' + on + '" title="' + esc(value) + '"' +
            (bg ? ' style="' + bg + '"' : "") + ">" + (bg ? '<span class="cl-sr">' + esc(value) + "</span>" : esc(value)) + "</button>";
        });
        html += "</div>";
      } else {
        html += '<select data-unit="' + i + '" data-opt="' + j + '" aria-label="' + esc(name) + '">';
        choices.forEach((value) => {
          const ok = valueAvailable(product, current, j, value);
          html +=
            '<option value="' + esc(value) + '"' + (values[j] === value ? " selected" : "") + ">" +
            esc(value) + (ok ? "" : " — sold out") + "</option>";
        });
        html += "</select>";
      }
    });
    html += "</div>";
  }
  return html + "</div>";
}

export function renderDeal(deal: SfDeal, state: RenderState, ctx: RenderCtx): string {
  const style = deal.style || {};
  const product = ctx.product;
  const variants = product.variants || [];
  const variant = variants.find((v) => String(v.id) === String(state.variantId)) || variants[0];
  if (!variant) return "";
  const unit = Number(variant.price) || 0;
  const compare = style.useCompareAt ? Number(variant.compare_at_price) || 0 : 0;
  const fmt = (cents: number) => formatMoney(cents, ctx.moneyFormat);
  const bars = state.bars || deal.bars;
  const layout = ["vertical", "horizontal", "grid"].indexOf(style.layout || "") >= 0 ? style.layout : "vertical";

  // Metafield text variables.
  const mfVars: Record<string, string> = {};
  for (const m of deal.mfv || []) {
    const value = ctx.mf?.[m.k];
    if (typeof value === "string" || typeof value === "number") mfVars[m.name] = String(value);
  }

  let html = '<div class="cl-block cl-layout-' + layout + '" style="' + styleVars(style) + '" data-deal="' + esc(deal.id) + '">';
  if (style.showBlockTitle && style.blockTitle) {
    html += '<div class="cl-heading"><span>' + esc(style.blockTitle) + "</span></div>";
  }
  html += '<div class="cl-bars" role="radiogroup">';

  bars.forEach((bar) => {
    const selected = bar.id === state.barId;
    const p = priceBar(bar, unit, compare, ctx.rate);
    const compareUnit = Number(variant.compare_at_price) > unit ? Number(variant.compare_at_price) : unit;
    const vars = {
      quantity: bar.qty,
      buy: bar.kind === "bxgy" ? bar.qty - (bar.get || 0) : bar.qty,
      get: bar.get || 0,
      price: fmt(p.total),
      full_price: fmt(p.full),
      compare_price: fmt(compareUnit * bar.qty),
      unit_price: fmt(p.unit),
      saved_amount: fmt(p.saved),
      saved_percentage: p.savedPct + "%",
      discount: discountText(bar, fmt, ctx.rate),
      product: product.title || "",
      ...mfVars,
    };

    // Sold out: the selected bar's chosen variants (or the current one) can't be bought.
    const rows = selected ? pickerRows(deal, bar, product) : 0;
    const chosen = rows
      ? Array.from({ length: rows }, (_, i) => (state.unitVariants && state.unitVariants[i]) || variant.id)
      : [variant.id];
    const soldOut = chosen.some((id) => variants.find((v) => String(v.id) === String(id))?.available === false);

    html +=
      '<div class="cl-bar' + (selected ? " is-selected" : "") + (soldOut ? " is-soldout" : "") +
      '" role="radio" tabindex="0" aria-checked="' + selected + '" data-bar="' + esc(bar.id) + '">';
    if (bar.badge) {
      html +=
        '<span class="cl-badge' + (bar.badgeStyle === "fancy" ? " cl-badge--fancy" : "") + '">' +
        text(bar.badge, vars) + "</span>";
    }
    html += '<span class="cl-radio" aria-hidden="true"></span>';
    if (bar.image?.url) {
      html += '<img class="cl-bar-img" src="' + esc(bar.image.url) + '" alt="' + esc(bar.image.alt || "") + '" loading="lazy">';
    }
    html += '<div class="cl-bar-main"><div class="cl-bar-head"><span class="cl-bar-title">' + text(bar.title, vars) + "</span>";
    if (bar.label) html += '<span class="cl-bar-label">' + text(bar.label, vars) + "</span>";
    html += "</div>";
    if (bar.subtitle) html += '<div class="cl-bar-sub">' + text(bar.subtitle, vars) + "</div>";
    const highlights = (bar.highlights || []).filter((h) => h && h.trim());
    if (highlights.length) {
      html += '<ul class="cl-highlights">' + highlights.map((h) => "<li>" + text(h, vars) + "</li>").join("") + "</ul>";
    }
    html += "</div>";
    html += '<div class="cl-bar-prices">';
    if (soldOut) html += '<span class="cl-soldout">Sold out</span>';
    html += '<span class="cl-price">' + esc(fmt(p.total)) + "</span>";
    if (p.full > p.total) html += '<span class="cl-full">' + esc(fmt(p.full)) + "</span>";
    if (style.showUnitPrice && bar.qty > 1) html += '<span class="cl-unit">' + esc(fmt(p.unit)) + " / each</span>";
    html += "</div>";

    // Extras: variant pickers (selected bar only), gift, upsells.
    let extras = "";
    if (rows) extras += renderPickers(deal, bar, rows, state, ctx, variant);
    if (bar.gift) {
      const giftPrice = moneyToCents(bar.gift.price, ctx.rate);
      extras +=
        '<div class="cl-gift">' +
        (bar.gift.image ? '<img class="cl-thumb" src="' + esc(bar.gift.image) + '" alt="" loading="lazy">' : "") +
        '<span class="cl-extra-text">' + text(bar.gift.text || "+ FREE gift", vars) + " — " + esc(bar.gift.title) + "</span>" +
        '<span class="cl-extra-price">' + esc(fmt(0)) + (giftPrice ? "<s>" + esc(fmt(giftPrice)) + "</s>" : "") + "</span></div>";
    }
    upsellEntries(bar, state, ctx).forEach((up) => {
      if (up.onlyWhenSelected && !selected) return;
      const pay = priceBar({ kind: "qty", qty: 1, dt: up.dt, dv: up.dv }, up.full, 0, ctx.rate).total;
      const upVars = { ...vars, product: up.title, price: fmt(pay), full_price: fmt(up.full) };
      extras +=
        '<label class="cl-upsell"><input type="checkbox" data-upsell="' + esc(up.key) + '"' + (upsellOn(up, state) ? " checked" : "") + ">" +
        (up.image ? '<img class="cl-thumb" src="' + esc(up.image) + '" alt="" loading="lazy">' : "") +
        '<span class="cl-extra-text">' + text(up.text, upVars) + "</span>" +
        '<span class="cl-extra-price">' + esc(fmt(pay)) + (up.full > pay ? "<s>" + esc(fmt(up.full)) + "</s>" : "") + "</span></label>";
    });
    if (extras) html += '<div class="cl-extras">' + extras + "</div>";
    html += "</div>";
  });

  html += "</div></div>";
  return html;
}
