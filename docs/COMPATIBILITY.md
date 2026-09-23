# Themes, page builders, cart drawers

What CartLift does to fit into a storefront it has never seen, and what is
actually proven. Anything marked **untested** works by design but has not been
run against the real product — say so rather than promising it to a merchant.

## How the widget finds its place

1. **App block** — the merchant drags "CartLift deals" into the product
   template. The block renders `.cartlift-slot`, and the widget mounts there.
   This is the placement to recommend: the merchant decides where it goes.
2. **`<cartlift-bundle product-id="…">`** — a custom element the merchant (or an
   agency) can drop anywhere in the product form. Useful in themes and builders
   that allow custom HTML but not app blocks.
3. **Automatic** — with the app embed on, the widget inserts itself above the
   add-to-cart button of the product form it recognises (`form[action*="/cart/add"]`
   whose `[name="id"]` is one of the product's variants).

Quick-view and quick-add forms are deliberately skipped (`cart-drawer`,
`[class*='quick-add']`, `aside`…): a deal belongs on the product page, and a
quick view usually cannot show one properly.

## Page builders

Builders render the product form *after* the page has loaded, and some rebuild
it whenever the shopper changes a variant. The widget therefore watches the
document and mounts again when a product form, a data block or its own slot
appears or disappears (`watchForChanges` in `packages/widget/src/storefront.ts`),
debounced so a busy page doesn't cost anything. It also re-mounts on
`shopify:section:load` (theme editor), `pageshow` (back/forward cache) and
`popstate`.

A product already mounted is left alone, so this can never double-render.

| Builder | Status |
|---|---|
| PageFly, GemPages, EComposer, Foxify, Instant, Replo | **untested** — handled by the generic late-render support above; use the app block or `<cartlift-bundle>` when the builder allows it |

## Cart drawers

When a tier unlocks a free gift, the watcher puts it in the cart and then asks
the theme to re-render:

1. `cartlift:cart-updated` on `document` — for anyone who wants to listen.
2. **`window.CartLift.onCartUpdated(cart)`** — if a theme or app defines this,
   it owns the refresh and nothing else is sent. One line is enough:

   ```js
   window.CartLift = { ...window.CartLift, onCartUpdated: () => myDrawer.reload() };
   ```

3. Dawn's `publish("cart-update")` pub/sub, when the theme has it.
4. Otherwise `cart:refresh`, `cart:build`, `theme:cart:reload`, `cart:updated`
   and `cart-drawer:refresh` on `documentElement` — the names themes and drawer
   apps listen to. They all mean "re-read the cart", so sending several is safe.

The cart icon bubble is re-fetched from the theme's own section either way, and
the cart *page* reloads (at most once every five seconds).

| Drawer | Status |
|---|---|
| Dawn and Dawn-derived themes | covered by the pub/sub path, exercised in tests |
| UpCart, Slide Cart, Rebuy and other drawer apps | **untested** — try the event path first, and fall back to `onCartUpdated` |

## Variant apps

The widget follows the form's `[name="id"]` (polled, and re-read whenever the
page changes), so an app that swaps the native variant picker for its own keeps
working as long as it writes the chosen variant back to that input — which is
how the cart form works for every theme.

| App | Status |
|---|---|
| 2048 Variants, variant-image apps | **untested** — expected to work through `[name="id"]` |

## Turning it off

Add `?cartlift=off` to any product URL to load the page without CartLift. That
is the first thing to try when a merchant reports a theme conflict.
