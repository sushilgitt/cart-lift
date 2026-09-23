import { useMemo, useState } from "react";

import { barPrice, initialBar, linesFor, type CartLiftBar, type CartLiftDeal, type CartLiftLine } from "./index";

/**
 * An optional React component for headless storefronts: the deal's bars, the
 * prices, and the lines to add. It carries no styles of its own beyond the
 * `cl-*` class names the theme widget uses, so a storefront can either drop in
 * the widget's stylesheet or write its own.
 *
 * Everything it does is available from `index.ts` — use that directly if you
 * would rather render the bars yourself.
 */

export interface CartLiftBarsProps {
  deal: CartLiftDeal;
  /** The price of one unit of the variant being viewed, in cents. */
  unitPrice: number;
  /** The variant the shopper is buying. */
  variantId: number | string;
  /** Called when the shopper adds to cart: pass these lines to cartLinesAdd. */
  onAdd: (lines: CartLiftLine[], bar: CartLiftBar) => void;
  /** The A/B arm this visitor is in, if you run tests headlessly. */
  arm?: string;
  /** A selling plan, when your page offers subscriptions. */
  sellingPlanId?: string | null;
  /** Cents → what the shopper should read, e.g. Intl.NumberFormat. */
  formatMoney: (cents: number) => string;
  addLabel?: string;
}

export function CartLiftBars({
  deal,
  unitPrice,
  variantId,
  onAdd,
  arm = "A",
  sellingPlanId = null,
  formatMoney,
  addLabel = "Add to cart",
}: CartLiftBarsProps) {
  const [barId, setBarId] = useState(() => initialBar(deal)?.id);
  const selected = deal.bars.find((b) => b.id === barId) ?? deal.bars[0];
  const prices = useMemo(
    () => new Map(deal.bars.map((bar) => [bar.id, barPrice(bar, unitPrice)])),
    [deal.bars, unitPrice],
  );

  if (!selected) return null;

  return (
    <div className="cl-block" data-deal={deal.id}>
      <div className="cl-bars" role="radiogroup">
        {deal.bars.map((bar) => {
          const price = prices.get(bar.id)!;
          const isSelected = bar.id === selected.id;
          return (
            // The real radio inside carries the semantics; the label is the card.
            <label key={bar.id} className={`cl-bar${isSelected ? " is-selected" : ""}`} data-bar={bar.id}>
              <input
                type="radio"
                name={`cartlift-${deal.id}`}
                checked={isSelected}
                onChange={() => setBarId(bar.id)}
                style={{ position: "absolute", opacity: 0 }}
              />
              {bar.badge ? <span className="cl-badge">{bar.badge}</span> : null}
              <span className="cl-radio" aria-hidden="true" />
              <div className="cl-bar-main">
                <div className="cl-bar-head">
                  <span className="cl-bar-title">{bar.title}</span>
                </div>
                {bar.subtitle ? <div className="cl-bar-sub">{bar.subtitle}</div> : null}
                {(bar.gifts ?? []).map((gift) => (
                  <div className="cl-gift" key={gift.id}>
                    <span className="cl-extra-text">+ {gift.title}</span>
                  </div>
                ))}
              </div>
              <div className="cl-bar-prices">
                <span className="cl-price">{formatMoney(price.total)}</span>
                {price.full > price.total ? <span className="cl-full">{formatMoney(price.full)}</span> : null}
              </div>
            </label>
          );
        })}
      </div>
      <button
        type="button"
        className="cl-add"
        onClick={() => onAdd(linesFor(deal, selected, { variantId, arm, sellingPlanId }), selected)}
      >
        {addLabel}
      </button>
    </div>
  );
}
