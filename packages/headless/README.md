# CartLift for headless storefronts

A headless storefront renders its own product page, so it can't use the theme
widget. It can still show CartLift deals and get the same checkout discounts,
because the discount Function keys off **cart line attributes**, not off the
widget:

| Attribute | On which line |
|---|---|
| `_cartlift` | the product the deal applies to |
| `_cartlift_arm` | the A/B variant the visitor is in (`A` when no test runs) |
| `_cartlift_bar` | only when two bars share a quantity |
| `_cartlift_gift` | a free gift a tier unlocked |
| `_cartlift_bundle` / `_cartlift_main` | the items of a "complete the bundle" bar |

`linesFor()` produces exactly those lines. Get them wrong and checkout simply
won't discount the order — so prefer this module over hand-writing attributes.

## Reading the config

The deals are published on the app installation as the `cartlift/deals` app-data
metafield, readable from the Storefront API:

```graphql
query CartLiftConfig {
  shop { id }
  metafield: shop { metafield(namespace: "cartlift", key: "deals") { value } }
}
```

> The exact query depends on how your storefront reads app-data metafields; in
> Hydrogen, fetch it once per request and cache it — it changes only when the
> merchant saves a deal.

## Using it

```ts
import { dealFor, initialBar, barPrice, linesFor } from "cartlift/headless";

const config = JSON.parse(metafield.value);
const deal = dealFor(config, { id: productId, collectionIds }, { country: "DE" });
if (deal) {
  const bar = initialBar(deal)!;
  const price = barPrice(bar, variantPriceInCents);  // { total, full, saved, unit }
  const lines = linesFor(deal, bar, { variantId, arm: "A" });
  // → cartLinesAdd(cartId, lines)
}
```

`src/react.tsx` has an optional `<CartLiftBars>` component that renders the bars
with the same `cl-*` class names the theme widget uses, so the widget's
stylesheet can be reused as-is. Rendering them yourself is equally fine —
everything it uses is exported from `src/index.ts`.

## What is not included

- **Free gifts added on their own** — the theme widget watches the cart and adds
  a gift when a tier is reached from elsewhere (a quantity bumped in the cart,
  say). A headless storefront owns its cart, so it has to call `linesFor` again
  after a change. `packages/core/src/cart.ts` has the same planning logic
  (`planGifts`) if you want the watcher's behaviour.
- **Analytics** — views and add-to-carts come from the theme widget and the web
  pixel. A headless storefront can post the same events to `/api/events`; see
  `beacon()` in `packages/widget/src/storefront.ts` for the shape.
- **Mix & match** — the chooser is part of the theme widget.

## Example

`examples/hydrogen/` shows a product route: reading the config, rendering the
bars and adding the lines to a Hydrogen cart.
