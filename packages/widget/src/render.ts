import { escapeHtml as esc, formatMoney, moneyToCents, priceBar, renderText } from "../../core/src";
import type { RenderCtx, RenderState, SfBar, SfDeal, SfStyle } from "./types";

/** Renders deal bars to HTML. Shared by the storefront and the admin live preview. */

const text = (value: string, vars: Record<string, string | number>) => renderText(value, vars, esc);

const has = (obj: object, key: string) => Object.prototype.hasOwnProperty.call(obj, key);

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
  };
  let out = "";
  for (const k in map) {
    const v = map[k];
    // Only plain CSS values: no quotes, semicolons or braces can break out.
    if (v != null && v !== "" && /^[#\w\s(),.%-]+$/.test(String(v))) out += k + ":" + v + ";";
  }
  return out;
}

export function initialBar(bars: SfBar[]): string | undefined {
  return (bars.find((b) => b.selected) || bars[0])?.id;
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

  let html = '<div class="cl-block cl-layout-' + layout + '" style="' + styleVars(style) + '" data-deal="' + esc(deal.id) + '">';
  if (style.showBlockTitle && style.blockTitle) {
    html += '<div class="cl-heading"><span>' + esc(style.blockTitle) + "</span></div>";
  }
  html += '<div class="cl-bars" role="radiogroup">';

  bars.forEach((bar) => {
    const selected = bar.id === state.barId;
    const p = priceBar(bar, unit, compare, ctx.rate);
    const vars = {
      quantity: bar.qty,
      buy: bar.kind === "bxgy" ? bar.qty - (bar.get || 0) : bar.qty,
      get: bar.get || 0,
      price: fmt(p.total),
      full_price: fmt(p.full),
      unit_price: fmt(p.unit),
      saved_amount: fmt(p.saved),
      saved_percentage: p.savedPct + "%",
      product: product.title || "",
    };

    html +=
      '<div class="cl-bar' + (selected ? " is-selected" : "") + '" role="radio" tabindex="0" aria-checked="' +
      selected + '" data-bar="' + esc(bar.id) + '">';
    if (bar.badge) {
      html +=
        '<span class="cl-badge' + (bar.badgeStyle === "fancy" ? " cl-badge--fancy" : "") + '">' +
        text(bar.badge, vars) + "</span>";
    }
    html += '<span class="cl-radio" aria-hidden="true"></span>';
    html += '<div class="cl-bar-main"><div class="cl-bar-head"><span class="cl-bar-title">' + text(bar.title, vars) + "</span>";
    if (bar.label) html += '<span class="cl-bar-label">' + text(bar.label, vars) + "</span>";
    html += "</div>";
    if (bar.subtitle) html += '<div class="cl-bar-sub">' + text(bar.subtitle, vars) + "</div>";
    html += "</div>";
    html += '<div class="cl-bar-prices"><span class="cl-price">' + esc(fmt(p.total)) + "</span>";
    if (p.full > p.total) html += '<span class="cl-full">' + esc(fmt(p.full)) + "</span>";
    if (style.showUnitPrice && bar.qty > 1) html += '<span class="cl-unit">' + esc(fmt(p.unit)) + " / each</span>";
    html += "</div>";

    // Extras: variant pickers (selected bar only), gift, upsells.
    let extras = "";
    const multiVariant = variants.length > 1 && deal.variantPerUnit;
    if (selected && multiVariant) {
      extras += '<div class="cl-variants">';
      for (let i = 0; i < bar.qty; i++) {
        const chosen = (state.unitVariants && state.unitVariants[i]) || variant.id;
        extras += '<label class="cl-variant-row"><span>#' + (i + 1) + '</span><select data-unit="' + i + '">';
        variants.forEach((v) => {
          extras +=
            '<option value="' + esc(v.id) + '"' + (String(v.id) === String(chosen) ? " selected" : "") +
            (v.available === false ? " disabled" : "") + ">" + esc(v.title) + (v.available === false ? " — sold out" : "") + "</option>";
        });
        extras += "</select></label>";
      }
      extras += "</div>";
    }
    if (bar.gift) {
      const giftPrice = moneyToCents(bar.gift.price, ctx.rate);
      extras +=
        '<div class="cl-gift">' +
        (bar.gift.image ? '<img class="cl-thumb" src="' + esc(bar.gift.image) + '" alt="" loading="lazy">' : "") +
        '<span class="cl-extra-text">' + text(bar.gift.text || "+ FREE gift", vars) + " — " + esc(bar.gift.title) + "</span>" +
        '<span class="cl-extra-price">' + esc(fmt(0)) + (giftPrice ? "<s>" + esc(fmt(giftPrice)) + "</s>" : "") + "</span></div>";
    }
    (bar.upsells || []).forEach((up) => {
      if (up.onlyWhenSelected && !selected) return;
      const full = moneyToCents(up.price, ctx.rate);
      const pay = priceBar({ kind: "qty", qty: 1, dt: up.dt, dv: up.dv }, full, 0, ctx.rate).total;
      const upVars = { ...vars, product: up.title, price: fmt(pay), full_price: fmt(full) };
      const checked = state.upsells && has(state.upsells, up.id) ? state.upsells[up.id] : up.checked;
      extras +=
        '<label class="cl-upsell"><input type="checkbox" data-upsell="' + esc(up.id) + '"' + (checked ? " checked" : "") + ">" +
        (up.image ? '<img class="cl-thumb" src="' + esc(up.image) + '" alt="" loading="lazy">' : "") +
        '<span class="cl-extra-text">' + text(up.text, upVars) + "</span>" +
        '<span class="cl-extra-price">' + esc(fmt(pay)) + (full > pay ? "<s>" + esc(fmt(full)) + "</s>" : "") + "</span></label>";
    });
    if (extras) html += '<div class="cl-extras">' + extras + "</div>";
    html += "</div>";
  });

  html += "</div></div>";
  return html;
}
