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
import { init } from "./storefront";
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

  /** Admin live preview. Returns an updater. */
  CL.preview = (el, deal, ctx) => {
    const state: RenderState = {
      barId: initialBar(deal.bars),
      variantId: ctx.product.variants[0] && ctx.product.variants[0].id,
      unitVariants: [],
      upsells: {},
      bars: deal.bars,
    };
    const draw = () => {
      el.innerHTML = renderDeal(deal, state, ctx);
    };
    el.onclick = (e) => {
      const target = e.target as Element;
      if (target.closest("select, input")) return;
      const bar = target.closest("[data-bar]");
      if (bar) {
        state.barId = bar.getAttribute("data-bar") || undefined;
        draw();
      }
    };
    draw();
    return (nextDeal, nextCtx) => {
      deal = nextDeal;
      ctx = nextCtx || ctx;
      state.bars = deal.bars;
      if (!deal.bars.some((b) => b.id === state.barId)) state.barId = initialBar(deal.bars);
      draw();
    };
  };
  CL.priceBar = priceBar;
  CL.formatMoney = formatMoney;

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
}
