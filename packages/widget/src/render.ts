import { escapeHtml as esc, formatMoney, moneyToCents, priceBar, priceBundle, priceMixed, renderText } from "../../core/src";
import { DEFAULT_STRINGS, type RenderCtx, type RenderState, type SfBar, type SfDeal, type SfGift, type SfProduct, type SfStyle, type SfVariant } from "./types";
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
    "--cl-title-weight": style.titleWeight ? String(style.titleWeight) : null,
    "--cl-subtitle-size": style.subtitleSize ? style.subtitleSize + "px" : null,
    "--cl-price-size": style.priceSize ? style.priceSize + "px" : null,
    "--cl-block-title-size": style.blockTitleSize ? style.blockTitleSize + "px" : null,
    "--cl-block-title-weight": style.blockTitleWeight ? String(style.blockTitleWeight) : null,
    "--cl-border-width": style.borderWidth != null ? style.borderWidth + "px" : null,
    "--cl-bar-gap": style.barGap != null ? style.barGap + "px" : null,
    "--cl-bar-padding": style.barPadding != null ? style.barPadding + "px" : null,
    "--cl-gift-bg": c.giftBg,
    "--cl-gift-text": c.giftText,
    "--cl-upsell-bg": c.upsellBg,
    "--cl-upsell-text": c.upsellText,
    "--cl-upsell-border": c.upsellBorder,
  };
  let out = "";
  for (const k in map) if (safeCss(map[k])) out += k + ":" + map[k] + ";";
  return out;
}

const cssUrl = (url: string) => "url('" + esc(url).replace(/'/g, "%27") + "')";

/** Merchant HTML for the admin preview: no scripts, handlers, frames or javascript: URLs. */
export function sanitizeHtml(html: string): string {
  if (!html) return "";
  if (typeof DOMParser === "undefined") return esc(html);
  const doc = new DOMParser().parseFromString("<body>" + html + "</body>", "text/html");
  doc.querySelectorAll("script, iframe, object, embed, link, meta, base, form").forEach((el) => el.remove());
  doc.querySelectorAll("*").forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on") || (/^(href|src|action|xlink:href|formaction)$/.test(name) && /^\s*javascript:/i.test(attr.value))) {
        el.removeAttribute(attr.name);
      }
    }
  });
  return doc.body.innerHTML;
}

/** The deal's own CSS, nested under its block (native CSS nesting scopes it). */
function scopedCss(dealId: string, css: string | undefined): string {
  if (!css || !css.trim()) return "";
  const body = css.replace(/<\/style/gi, "<\\/style");
  return '<style data-cartlift-css="' + esc(dealId) + '">.cl-block[data-deal="' + esc(dealId).replace(/"/g, "") + '"]{' + body + "}</style>";
}

/** "You're saving $X": the selected bar's saving, plus gifts and ticked upsells. */
function renderSavings(style: SfStyle, saved: number, full: number, fmt: (c: number) => string): string {
  const sb = style.savingsBar;
  if (!sb?.enabled || saved <= 0) return "";
  const vars = {
    saved_amount: '<span class="cl-savings-value">' + esc(fmt(saved)) + "</span>",
    saved_percentage: '<span class="cl-savings-value">' + (full > 0 ? Math.round((saved / full) * 100) : 0) + "%</span>",
  };
  // Escape the text, then drop the (already escaped) value spans in.
  const text = esc(sb.text || "").replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key as keyof typeof vars] : m,
  );
  const css: string[] = [];
  if (safeCss(sb.background)) css.push("--cl-sb-bg:" + sb.background);
  if (safeCss(sb.textColor)) css.push("--cl-sb-text:" + sb.textColor);
  if (safeCss(sb.valueColor)) css.push("--cl-sb-value:" + sb.valueColor);
  if (sb.size) css.push("--cl-sb-size:" + Math.min(24, Math.max(10, sb.size)) + "px");
  const align = sb.align === "left" || sb.align === "right" ? sb.align : "center";
  return (
    '<div class="cl-savings cl-savings--' + align + (sb.border ? " cl-savings--border" : "") + '" style="' + css.join(";") + '" role="status">' +
    (sb.icon ? '<span class="cl-savings-icon" aria-hidden="true">✓</span>' : "") +
    "<span>" + text + "</span></div>"
  );
}

/** A bar's gifts (older configs had a single `gift`). */
export const barGifts = (bar: SfBar): SfGift[] => bar.gifts ?? (bar.gift ? [bar.gift] : []);

/** Mix & match slots of a bar: one per unit (quantity and BXGY bars). */
export const mixSlots = (deal: SfDeal, bar: SfBar) => (deal.mm && bar.kind !== "bundle" ? Math.max(1, bar.qty) : 0);

/** Price of a bundle bar for the current variant (cents). */
export function bundlePrice(bar: SfBar, unit: number, rate: number) {
  return priceBundle(
    (bar.items || []).map((it) => ({
      unit: it.v == null ? unit : moneyToCents(it.price, rate),
      q: it.q,
      dt: it.dt,
      dv: it.dv,
    })),
    rate,
  );
}

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
  // Bundle bars use the viewed variant; mix & match units are picked in the chooser.
  if (bar.kind === "bundle") return deal.showVariantPicker ? 1 : 0;
  if (deal.mm) return deal.showVariantPicker || deal.variantPerUnit ? 1 : 0;
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

/** Progressive gifts: each tier's newly unlocked gifts, locked or unlocked for the selected bar. */
function renderGiftTrack(deal: SfDeal, bars: SfBar[], state: RenderState, ctx: RenderCtx): string {
  if (!deal.style?.giftTrack) return "";
  const tiers = bars.filter((b) => b.kind !== "bundle" && barGifts(b).length).sort((a, b) => a.qty - b.qty);
  if (!tiers.length) return "";
  const selected = bars.find((b) => b.id === state.barId);
  const reached = selected && selected.kind !== "bundle" ? selected.qty : 0;
  const seen = new Set<number>();
  let html = '<ol class="cl-gift-track">';
  for (const tier of tiers) {
    const fresh = barGifts(tier).filter((g) => !seen.has(g.id));
    fresh.forEach((g) => seen.add(g.id));
    if (!fresh.length) continue;
    const open = reached >= tier.qty;
    const words = ctx.strings ?? DEFAULT_STRINGS;
    html +=
      '<li class="cl-gt-step' + (open ? " is-unlocked" : "") + '">' +
      '<span class="cl-gt-gifts">' +
      fresh
        .map((g) =>
          g.image
            ? '<img class="cl-thumb" src="' + esc(g.image) + '" alt="' + esc(g.title) + '" loading="lazy">'
            : '<span class="cl-gt-name">' + esc(g.title) + "</span>",
        )
        .join("") +
      "</span>" +
      '<span class="cl-gt-label">' + (open ? esc(words.unlocked) : text(words.buy, { quantity: tier.qty })) + "</span></li>";
  }
  return html + "</ol>";
}

function renderBundleItems(bar: SfBar, ctx: RenderCtx, variant: SfVariant, fmt: (c: number) => string): string {
  const unit = Number(variant.price) || 0;
  let html = '<div class="cl-bundle-items">';
  for (const it of bar.items || []) {
    const main = it.v == null;
    const full = main ? unit : moneyToCents(it.price, ctx.rate);
    const pay = priceBundle([{ unit: full, q: 1, dt: it.dt, dv: it.dv }], ctx.rate).total;
    const title = main ? ctx.product.title || "" : it.title || "";
    const image = main ? null : it.image;
    html +=
      '<div class="cl-bundle-item">' +
      (image ? '<img class="cl-thumb" src="' + esc(image) + '" alt="" loading="lazy">' : '<span class="cl-thumb cl-thumb--main" aria-hidden="true"></span>') +
      '<span class="cl-extra-text">' + esc(title) + (it.q > 1 ? " × " + it.q : "") + (main && variant.title && variant.title !== "Default Title" ? " — " + esc(variant.title) : "") + "</span>" +
      '<span class="cl-extra-price">' + esc(fmt(pay * it.q)) + (full > pay ? "<s>" + esc(fmt(full * it.q)) + "</s>" : "") + "</span></div>";
  }
  return html + "</div>";
}

function renderSlots(
  deal: SfDeal,
  slots: number,
  state: RenderState,
  ctx: RenderCtx,
  variant: SfVariant,
  fmt: (c: number) => string,
): string {
  const mm = deal.mm!;
  const words = ctx.strings ?? DEFAULT_STRINGS;
  const photo = safeCss(mm.photo) ? Math.min(160, Math.max(24, Number(mm.photo))) : 64;
  let html = '<div class="cl-slots" style="--cl-slot-photo:' + photo + 'px">';
  for (let i = 0; i < slots; i++) {
    const pick = i === 0 ? null : state.mix?.[i];
    if (i === 0 || pick) {
      const title = i === 0 ? (ctx.product.title || "") + (variant.title && variant.title !== "Default Title" ? " — " + variant.title : "") : pick!.title;
      const price = i === 0 ? Number(variant.price) || 0 : pick!.price;
      html +=
        '<div class="cl-slot is-filled">' +
        '<span class="cl-unit-no">#' + (i + 1) + "</span>" +
        (pick?.image ? '<img class="cl-thumb" src="' + esc(pick.image) + '" alt="" loading="lazy">' : "") +
        '<span class="cl-extra-text">' + (mm.names === false ? "" : esc(title)) + "</span>" +
        '<span class="cl-extra-price">' + esc(fmt(price)) + "</span>" +
        (i === 0 ? "" : '<button type="button" class="cl-slot-change" data-slot="' + i + '">' + esc(mm.button || words.choose) + "</button>") +
        "</div>";
    } else {
      html +=
        '<button type="button" class="cl-slot" data-slot="' + i + '">' +
        '<span class="cl-unit-no">#' + (i + 1) + "</span>" +
        '<span class="cl-extra-text">' + esc(mm.button || words.choose) + "</span></button>";
    }
  }
  return html + "</div>";
}

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
  const words = ctx.strings ?? DEFAULT_STRINGS;
  const layout = ["vertical", "horizontal", "grid", "plain"].indexOf(style.layout || "") >= 0 ? style.layout : "vertical";
  // Savings of the selected bar, for the savings bar.
  let savedTotal = 0;
  let fullTotal = 0;

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
  html += scopedCss(deal.id, style.customCss);
  if (style.htmlAbove) html += '<div class="cl-html cl-html--above">' + (ctx.preview ? sanitizeHtml(style.htmlAbove) : style.htmlAbove) + "</div>";
  html += renderGiftTrack(deal, bars, state, ctx);
  html += '<div class="cl-bars" role="radiogroup">';

  bars.forEach((bar) => {
    const selected = bar.id === state.barId;
    const bundle = bar.kind === "bundle";
    const slots = mixSlots(deal, bar);
    const picks = selected && slots ? Array.from({ length: slots - 1 }, (_, i) => state.mix?.[i + 1]) : [];
    const p = bundle
      ? { ...bundlePrice(bar, unit, ctx.rate), unit: 0 }
      : picks.length && picks.every(Boolean)
        ? { ...priceMixed(bar, [unit, ...picks.map((x) => x!.price)], ctx.rate), unit: 0 }
        : priceBar(bar, unit, compare, ctx.rate);
    if (!p.unit) p.unit = Math.round(p.total / Math.max(1, bar.qty));
    const compareUnit = Number(variant.compare_at_price) > unit ? Number(variant.compare_at_price) : unit;
    const vars = {
      quantity: bundle ? (bar.items || []).reduce((sum, it) => sum + it.q, 0) : bar.qty,
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
    if (soldOut) html += '<span class="cl-soldout">' + esc(words.soldOut) + "</span>";
    html += '<span class="cl-price">' + esc(fmt(p.total)) + "</span>";
    if (p.full > p.total) html += '<span class="cl-full">' + esc(fmt(p.full)) + "</span>";
    if (style.showUnitPrice && bar.qty > 1 && !bundle)
      html += '<span class="cl-unit">' + esc(fmt(p.unit)) + " " + esc(words.each) + "</span>";
    html += "</div>";

    // Extras: bundle items, mix & match slots, variant pickers (selected bar only), gifts, upsells.
    let extras = "";
    if (bundle) extras += renderBundleItems(bar, ctx, variant, fmt);
    if (selected && slots > 1) extras += renderSlots(deal, slots, state, ctx, variant, fmt);
    if (rows) extras += renderPickers(deal, bar, rows, state, ctx, variant);
    barGifts(bar).forEach((gift) => {
      const giftPrice = moneyToCents(gift.price, ctx.rate);
      extras +=
        '<div class="cl-gift">' +
        (gift.image ? '<img class="cl-thumb" src="' + esc(gift.image) + '" alt="" loading="lazy">' : "") +
        '<span class="cl-extra-text">' + text(gift.text || words.freeGift, vars) + " — " + esc(gift.title) + "</span>" +
        '<span class="cl-extra-price">' + esc(fmt(0)) + (giftPrice ? "<s>" + esc(fmt(giftPrice)) + "</s>" : "") + "</span></div>";
    });
    if (selected) {
      savedTotal += p.saved;
      fullTotal += p.full;
      if (deal.style?.savingsBar?.includeGifts) {
        for (const gift of barGifts(bar)) {
          const value = moneyToCents(gift.price, ctx.rate);
          savedTotal += value;
          fullTotal += value;
        }
      }
    }
    upsellEntries(bar, state, ctx).forEach((up) => {
      if (up.onlyWhenSelected && !selected) return;
      const pay = priceBar({ kind: "qty", qty: 1, dt: up.dt, dv: up.dv }, up.full, 0, ctx.rate).total;
      if (selected && upsellOn(up, state)) {
        savedTotal += Math.max(0, up.full - pay);
        fullTotal += up.full;
      }
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

  html += "</div>";
  html += renderSavings(style, savedTotal, fullTotal, fmt);
  if (style.htmlBelow) html += '<div class="cl-html cl-html--below">' + (ctx.preview ? sanitizeHtml(style.htmlBelow) : style.htmlBelow) + "</div>";
  html += "</div>";
  return html;
}
