# CartLift — build plan

CartLift is a feature-by-feature rebuild of Kaching Bundles (quantity breaks,
BOGO, gifts and upsells on the product page). See `RESEARCH.md` for the
functional spec it is modelled on.

## Architecture

| Piece | Where | Job |
|---|---|---|
| Admin app | `app/` (React Router + Polaris web components) | Deal CRUD, styling, analytics, settings |
| Database | Postgres via Prisma (`prisma/schema.prisma`) | Shops, deals, daily stats, attributed orders |
| Discount Function | `extensions/cartlift-discount` | Automatic product discount; prices the cart from the deal config |
| Theme extension | `extensions/cartlift-widget` | App embed (auto-inject) + app block; renders the bars and adds to cart |
| Web pixel | `extensions/cartlift-pixel` | Attributes completed checkouts to deals without `read_orders` |

### Data flow

1. Merchant saves a deal → `syncShop()` (app/lib/sync.server.ts) publishes two
   JSON documents:
   * **Function config** → metafield `$app:cartlift/config` on CartLift's single
     automatic app discount (created on first sync). Compact: targeting + bars.
   * **Storefront config** → app-data metafield `cartlift/deals` on the
     AppInstallation, read by Liquid as `app.metafields.cartlift.deals`.
     No network call is needed to render the widget.
   * **Gift config** → app-data metafield `cartlift/gifts`: the targeting and
     bar quantities the cart watcher needs, inlined on every page.
2. Shopper picks a bar → the widget sets the form quantity and adds line
   properties `_cartlift` (deal id) and `_cartlift_arm` (A/B arm) → theme adds
   to cart as usual (cart drawer behaviour stays the theme's).
3. The Discount Function counts units per (deal, product) — or per deal for
   "count across products" deals — from *any* line of an eligible product, picks
   the highest reached bar, and emits product discounts.
4. The cart watcher (`cartlift-cart.js`, every page via the app embed) sees
   each Ajax cart change, works out the reached bars with the Function's
   rules, and adds, removes or trims gift lines to match — so gifts follow the
   cart however it got there (repeat adds, cart quantity edits, quick-add).
5. Widget beacons views/add-to-carts to `/api/events`; the pixel reports
   `checkout_completed` with deal lines → `DailyStat` + `DealOrder`.

Fixed amounts are stored in shop currency and converted with
`presentmentCurrencyRate` (function) / `Shopify.currency.rate` (widget).

## Phases

### Phase 1 — MVP (quantity breaks end to end)
- [x] Template, Postgres, app link, extensions scaffolded
- [ ] Shop provisioning, compliance + uninstall webhooks
- [ ] Deal model + CRUD (list, create from template, edit, duplicate, delete, status)
- [ ] Bars: qty, title, subtitle, label, badge, default selected; discount none / % / amount off per item / fixed total
- [ ] Visibility: all / products / collections / all except; schedule start/end
- [ ] Style: layout (vertical/horizontal/grid), colours, radius, block title, unit price, compare-at
- [ ] Discount Function + automatic discount + config sync
- [ ] Theme app embed (auto-inject) + app block, live admin preview
- [ ] Deploy to Coolify (isolated project + Postgres)

### Phase 2 — Kaching parity on the widget
- BXGY bars (free / % / amount on Y), free gift per bar, upsell checkboxes
- Per-unit variant pickers, default variants
- Dynamic text variables ({{saved_amount}}, {{saved_percentage}}, {{quantity}}, …)
- Translations per shop locale, sticky add-to-cart, custom CSS

### Phase 3 — Analytics, A/B tests, billing
- Views, ATC, orders, revenue, added revenue, AOV, CR per deal / bar, date range, CSV export
- A/B test (2–4 arms, custom split, z-test on CR, ≥10 orders/arm)
- Shopify managed pricing plans keyed on monthly added revenue, usage meter

### Phase 4 — Bundles beyond one product
- Quantity breaks across different products (choose-product modal), collection breaks
- Complete-the-bundle bars, progressive gifts, brand colour palette
