# Kaching Bundles — functional spec (research, 2026-09-19)

Reference app: https://apps.shopify.com/bundle-deals (Kaching Bundles App & Upsells,
Vilnius LT, launched 2022-08, 5.0★ / ~5,960 reviews, Built for Shopify).
Help center: https://support.kachingappz.com. Items marked [inferred] were not stated
in a source.

## Deal templates ("Create bundle deal")
1. Quantity breaks for the same product (tiered bars + variant selector)
2. Buy X, get Y (BOGO) — Y discount: free / % / amount off / fixed price; Y shows at $0
3. Quantity breaks for different products (mix & match with a "choose product" modal)
4. Complete the bundle (hand-picked products/variants, each with its own discount)
5. Subscription
6. Progressive gifts (gifts unlock as bigger bars are chosen)

A template only seeds the bars; one deal may mix bar types (Quantity break, BXGY, Bundle upsell).

## Bar settings
- quantity (unique per deal), title (default discount name at checkout), subtitle, label, badge
  ("Most popular", simple/fancy style), selected by default, bar image
- discount: % per item, amount off per item, or custom total price
- price display: sale price, strikethrough full price, unit price; optional "use product
  compare-at price" × quantity
- free gift on bar; upsell checkboxes on bar (price override, text, image, pre-checked,
  visible only when bar selected)
- per-unit variant pickers ("Let customers choose different variants for each item"),
  default variants, swatches (colour/image), out-of-stock state
- dynamic variables in text: discount group (saved amount/%), product group, 4 custom metafields

## Widget style ("Settings & style")
- layouts: vertical (default), horizontal, grid (2 cols), plain
- block title ("BUNDLE & SAVE") with colour/size/weight
- colours: bar bg / selected bg / border / selected border, title, subtitle, label text+bg,
  price, full price, badge bg+text, gift & upsell colours
- corner radius, spacing, image sizes, brand-colour palette, sticky add-to-cart, custom CSS,
  live preview

## How discounts apply
- One automatic app discount (product class) backed by a Shopify Discount Function.
- Cart lines stay separate (no cart transform). Line properties tag deal/bar.
- Units of the same product added from anywhere count toward the tiers ("collection breaks").
- Combines with order + shipping discounts; with other product discounts only on other items.
- Widget sits inside `form[action="/cart/add"]`, sets the quantity; multi-line adds hide Buy-it-now.
- Markets dropdown per deal; money formats follow the shop; translations with auto-translate.

## Targeting
All products / selected products / all except selected / products in collections; markets;
start–end schedule. No customer-tag targeting (merchants ask for it — an opportunity).
Placement: auto-inject via app embed, app block (dynamic product source), or custom element.

## Analytics & A/B
Metrics: revenue, added revenue, bundle orders, visitors, CR, AOV, revenue/visitor,
ATC, ATC rate, checkout rate, units per order; per deal, bar, product, A/B arm; date range,
compare period, CSV export. "Added revenue" = paid minus the single-unit price.
A/B: up to 4 arms, even or custom split, sticky per visitor (localStorage), z-test on CR,
≥10 orders per arm, "no clear winner" state.

## Onboarding
Install → enable app embed in theme editor → create deal from template → publish.
Debug switch `?kaching=off`. Storefront events: deal-bar-selected, variant-selected.

## Pricing
Dev stores free. Starter $14.99 (≤$1k added revenue/mo), Scale $29.99 (≤$5k), Pro $59.99
(≤$10k), higher "flex" tiers to $299. 7-day trial. Billed on monthly added revenue.

## Complaints worth beating
Wrong variants forced into orders, missing free gifts, surprise bill jumps, slow support,
no customer-tag targeting, no draft-order/POS pricing, Buy-it-now hidden, only 1 unit added
on themes without a quantity input.
