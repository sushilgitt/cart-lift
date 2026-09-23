/**
 * CartLift in a Hydrogen product route.
 *
 * Copy this file into your Hydrogen app (and `packages/headless/src` next to
 * it, or publish that as your own package). It shows the three things a
 * headless storefront has to do:
 *
 *   1. read the published deals once per request,
 *   2. find the deal for the product being viewed,
 *   3. add the lines CartLift produced — with their attributes — to the cart,
 *      so the discount Function recognises them at checkout.
 *
 * Nothing here is Hydrogen-specific except the `CartForm`; the same three steps
 * work in any storefront that can call the Storefront API.
 */

import { CartForm } from "@shopify/hydrogen";
import { useState } from "react";

import { barPrice, dealFor, initialBar, linesFor, type CartLiftConfig } from "../../packages/headless/src";

/** App-data metafields of the shop, where CartLift publishes its deals. */
export const CARTLIFT_CONFIG_QUERY = `#graphql
  query CartLiftConfig {
    shop {
      metafield(namespace: "cartlift", key: "deals") {
        value
      }
    }
  }
`;

export function parseConfig(value?: string | null): CartLiftConfig | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as CartLiftConfig;
  } catch {
    return null;
  }
}

interface Props {
  config: CartLiftConfig | null;
  product: { id: number; collectionIds?: number[] };
  /** The variant the shopper is looking at. */
  variant: { id: string; price: { amount: string; currencyCode: string } };
  country?: string;
}

export function ProductDeal({ config, product, variant, country }: Props) {
  const deal = dealFor(config, product, { country });
  const [barId, setBarId] = useState(() => (deal ? initialBar(deal)?.id : undefined));
  if (!deal) return null;

  const bar = deal.bars.find((b) => b.id === barId) ?? deal.bars[0];
  const unitPrice = Math.round(Number(variant.price.amount) * 100);
  const money = (cents: number) =>
    new Intl.NumberFormat(undefined, { style: "currency", currency: variant.price.currencyCode }).format(cents / 100);

  // These are exactly the lines cartLinesAdd wants, attributes and all.
  const lines = linesFor(deal, bar, { variantId: variant.id });

  return (
    <div className="cartlift">
      <fieldset>
        <legend>{deal.name}</legend>
        {deal.bars.map((option) => {
          const price = barPrice(option, unitPrice);
          return (
            <label key={option.id} style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type="radio"
                name="cartlift-bar"
                checked={option.id === bar.id}
                onChange={() => setBarId(option.id)}
              />
              <span>{option.title}</span>
              {option.subtitle ? <small>{option.subtitle}</small> : null}
              <strong style={{ marginLeft: "auto" }}>{money(price.total)}</strong>
              {price.full > price.total ? <s>{money(price.full)}</s> : null}
            </label>
          );
        })}
      </fieldset>

      <CartForm route="/cart" action={CartForm.ACTIONS.LinesAdd} inputs={{ lines }}>
        <button type="submit">Add {bar.qty > 1 ? `${bar.qty} ` : ""}to cart</button>
      </CartForm>
    </div>
  );
}

/**
 * A note on gifts: a free gift is added as its own line here, at full price in
 * the cart, and checkout takes it to $0 through the discount Function. Showing
 * the shopper "Free" next to it in the cart is up to your cart component — the
 * line carries `_cartlift_gift`, so it is easy to spot.
 */
