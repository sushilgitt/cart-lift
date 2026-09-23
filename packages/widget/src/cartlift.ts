/*
 * CartLift storefront widget — built to extensions/cartlift-widget/assets/cartlift.js
 * by scripts/build-widget.mjs. Edit this source, not the built asset.
 *
 * Reads the config inlined by snippets/cartlift-data.liquid and renders the
 * deal bars on the product page (see storefront.ts). Checkout prices come from
 * the Discount Function; both use packages/core, so the numbers match.
 *
 * `window.CartLift.preview()` is used by the admin editor for a live preview.
 */
import { formatMoney, priceBar } from "../../core/src";
import { initialBar, renderDeal } from "./render";
import { init, watchForChanges } from "./storefront";
import type { RenderCtx, RenderState, SfDeal } from "./types";

interface CartLiftGlobal {
  loaded?: boolean;
  preview?: (el: HTMLElement, deal: SfDeal, ctx: RenderCtx) => (deal: SfDeal, ctx?: RenderCtx) => void;
  priceBar?: typeof priceBar;
  formatMoney?: typeof formatMoney;
}

const w = window as unknown as { CartLift?: CartLiftGlobal };

if (!w.CartLift?.loaded) {
  const CL: CartLiftGlobal = (w.CartLift = w.CartLift || {});
  CL.loaded = true;

  /**
   * The preview can't know a selling plan's real price (that's storefront
   * data), so it shows a sample plan at the product's own price: the merchant
   * sees the picker and its texts, not an invented discount.
   */
  const previewPlans = (deal: SfDeal, ctx: RenderCtx): RenderCtx => {
    if (!deal.sub?.on || ctx.plans?.length) return ctx;
    const alloc: Record<string, { p: number; price: number; cap: null }[]> = {};
    for (const variant of ctx.product.variants || []) {
      alloc[String(variant.id)] = [{ p: 1, price: Number(variant.price) || 0, cap: null }];
    }
    return { ...ctx, plans: [{ id: "preview", name: "Subscription", plans: [{ id: 1, name: "Every 2 weeks" }] }], alloc };
  };

  /** Admin live preview. Returns an updater. */
  CL.preview = (el, deal, ctx) => {
    ctx = previewPlans(deal, { ...ctx, preview: true });
    const state: RenderState = {
      barId: initialBar(deal.bars),
      variantId: ctx.product.variants[0] && ctx.product.variants[0].id,
      unitVariants: [],
      upsells: {},
      bars: deal.bars,
      plan: deal.sub?.on && (deal.sub.pre === "sub" || deal.sub.apply === "s") ? 1 : null,
    };
    const draw = () => {
      el.innerHTML = renderDeal(deal, state, ctx);
    };
    el.onclick = (e) => {
      const target = e.target as Element;
      if (target.closest("select, input")) return;
      const plan = target.closest<HTMLElement>("[data-plan]");
      if (plan) {
        state.plan = plan.dataset.plan ? Number(plan.dataset.plan) : null;
        draw();
        return;
      }
      const bar = target.closest("[data-bar]");
      if (bar) {
        state.barId = bar.getAttribute("data-bar") || undefined;
        draw();
      }
    };
    draw();
    return (nextDeal, nextCtx) => {
      deal = nextDeal;
      ctx = previewPlans(deal, nextCtx ? { ...nextCtx, preview: true } : ctx);
      state.bars = deal.bars;
      if (!deal.bars.some((b) => b.id === state.barId)) state.barId = initialBar(deal.bars);
      draw();
    };
  };
  CL.priceBar = priceBar;
  CL.formatMoney = formatMoney;

  const start = () => {
    init();
    // Page builders and quick views render the form after this point.
    watchForChanges();
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
}
