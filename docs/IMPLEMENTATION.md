# CartLift — implementation plan for the missing features

How each gap in [`PARITY.md`](PARITY.md) gets built. Phases match PARITY.md.
Every feature lists the same layers so nothing is forgotten:

- **Model** — `DealConfig` (`app/lib/deals.ts`, JSON, no migration) or Prisma schema
- **Admin** — editor/pages in `app/routes`
- **Sync** — what `app/lib/sync.server.ts` publishes (Function config, storefront config, gift config)
- **Widget** — `extensions/cartlift-widget` (renderer, cart watcher, Liquid)
- **Function** — `extensions/cartlift-discount`
- **Tests** — what proves it

API facts verified 2026-09-22 against shopify.dev are marked ✔; anything to
confirm at the start of the phase is marked *(verify)*.

---

## Cross-cutting decisions (land in Phase 0, used by every later phase)

### A. One pricing core, one widget build
Pricing is written three times today (admin `deals.ts`, `cartlift.js`, the
Function). The later phases add bundle-upsell, extra-% BXGY, subscriptions and
markets — tripling each of those is how bugs ship.

- New workspace package `packages/core` (pure TypeScript, no DOM, no Node APIs):
  `priceBar`, `reachedBar`, eligibility, gift planning, text variables, money format.
- Function imports it directly (Javy bundles it).
- Widget moves to TypeScript source in `packages/widget/src/` (theme app
  extensions may only contain assets/blocks/locales/snippets), bundled by
  esbuild (`scripts/build-widget.mjs`) into the extension's `assets/cartlift.js`
  and `assets/cartlift-cart.js`. `npm run deploy` and `npm run build` build it
  first; a test fails if the committed assets are stale. ✅ Done in Phase 0.
- Admin preview keeps loading the built asset (`?url`), so preview = storefront.
- Existing parity tests become tests of `packages/core` plus a thin check that
  the Function and widget call it.

### B. Config versioning
- `normalizeConfig` stays the only place defaults are filled; every new field is
  optional with a default, so old deals keep working.
- Storefront config gets `v: 2` when its shape changes; the widget accepts v1 and v2
  for one release (theme assets and metafields can update at different moments).
- Size budget: the storefront config is inlined on every product page — keep it
  under ~64 KB. Translations and large lists go into separate metafields (see 5.1).

### C. Storefront performance budget (Built for Shopify)
- `cartlift.js` ≤ 25 KB gzip for the core path; the mix-and-match modal, swatches,
  sticky bar and savings bar are split chunks loaded only when a deal uses them.
- No layout shift: the slot reserves height before render.

### D. Scopes — batch them into one merchant approval
Adding scopes forces every store to re-approve. Add all planned scopes in the
**Phase 1 release**, even if used later:

| Scope | Needed for | Phase |
|---|---|---|
| `write_files` | Bar images, custom swatch images uploaded to Shopify Files | 1 |
| `read_inventory` | `InventoryItem.unitCost` → profit metrics | 3 |
| `read_markets` | Markets picker | 5 |
| `read_locales` | Store languages for translations | 5 |

Update `shopify.app.toml`, the scope comments there, and the privacy page.

### E. Test layers
1. `packages/core` unit tests (pricing, eligibility, gifts, bundles, subscriptions).
2. Function tests (existing vitest setup) incl. widget↔Function parity.
3. Widget DOM tests with vitest + happy-dom (render, selection, cart payloads).
4. Storefront smoke with Playwright on the dev store: Dawn + one non-Dawn theme
   (e.g. Horizon or a paid theme with a custom drawer). Runs before each release.

### F. Release checklist (end of every phase)
Typecheck, lint, all tests → `npm run deploy` → Coolify redeploy (enable Auto
Deploy) → startup sync republishes shops → Playwright smoke → update PARITY.md.

---

## Phase 0 — Align & harden

### 0.1 Security: bind upsell discounts to their product  **(P0)**
The Function discounts any line tagged `_cartlift_upsell=<deal>:<upsell>`
without checking the product (`cart_lines_discounts_generate_run.ts:283-293`).
Line properties are shopper-controlled, so any product can get the upsell price.
- **Sync:** add the variant to each Function upsell: `ups: [{ id, v, dt, dv }]`.
- **Function:** apply only when `line.merchandise.id === up.v`; one discounted
  unit per upsell per deal (same rule as gifts).
- **Tests:** tagged foreign product gets nothing; real upsell still discounted;
  quantity 3 of the upsell → one unit discounted.
- Audit the other tags the same way: gifts already check the variant; bundle
  items (2.2) and arms (3.5) must too.

### 0.2 Plan copy
Remove "A/B testing" from `app/lib/plans.ts` until 3.5 ships.

### 0.3 Same quantity on two bars
Kaching allows it when the discounts match, else errors "Discounts must be the
same for the same quantity".
- **Model/Admin:** change `validateConfig` rule and message.
- **Function/core:** `reachedBar` already picks one; make the tie-break explicit
  (first bar in the editor order) and identical in widget and Function.

### 0.4 Merge duplicate variant lines
Kaching merges the same variant added twice (e.g. once through the widget, once
from a collection page) into one line.
- **Widget:** extend the cart watcher: load it whenever any deal is live (not only
  gift deals — publish `g` → `live` flag), and when two lines have the same variant
  and one carries `_cartlift`, move the untagged quantity onto the tagged line
  (`/cart/update.js`). Skip lines with selling plans or other app properties.
- **Tests:** runtime-sim scenarios for merge + no merge across different properties.

### 0.5 Checkout rate and units per order
- **Pixel:** subscribe to `checkout_started`; report deal ids in the checkout.
- **Model:** `DailyStat.checkouts Int @default(0)` (migration).
- **Admin:** show checkout rate and units per order in Analytics + dashboard.

### 0.6 POS and theme verification
POS is ✔ supported by discount functions. Verify on a POS dev device: untagged
lines count toward tiers (they do in the Function); gifts are not auto-added in
POS (no storefront) — document it, as Kaching does.
Run the Playwright smoke on Dawn + one other theme; fix selector gaps in `findForm`.

### 0.7 Cross-cutting A–C above.

**Exit:** security fix released, core package + widget build in place, all
existing behaviour unchanged (parity tests green).

---

## Phase 1 — Bars & variants

### 1.1 Bar image
- **Model:** `Bar.image: { url, alt } | null`.
- **Admin:** upload via `stagedUploadsCreate` → `fileCreate` (Shopify Files, `write_files`);
  or pick an existing product image. Show in editor + preview.
- **Widget:** image left of the title; size from style (4.1).

### 1.2 Bar highlights
- **Model:** `Bar.highlights: string[]` (max 4), variables allowed.
- **Widget:** list with check icons under the subtitle; translatable (5.1).

### 1.3 Variant picker on single-quantity bars
- **Model:** `DealConfig.showVariantPicker: boolean` (default true).
- **Widget:** picker for qty 1 bars that writes the theme form's `id` input and
  fires `change` so theme price/media update. Off → theme picker is used.

### 1.4 Default variants
- **Model:** `Bar.defaultVariants: string[]` (per unit, variant GIDs).
- **Admin:** "Set default variants" per bar (variant resource picker).
- **Widget:** initial `unitVariants`; falls back to the current variant if a default is unavailable.

### 1.5 Swatches
- **Model:** `DealStyle.variants = { display: "dropdown"|"swatch", source: "color"|"image"|"variant_image", shape: "circle"|"rounded"|"square", size: number }`.
- **Liquid:** `cartlift-data` emits options with swatch data:
  `product.options_with_values[].values[].swatch.color / .image` ✔ (Shopify option swatches), plus `variant.featured_image`.
- **Widget:** per-unit picker becomes option-based (one control per option,
  resolved to a variant) instead of a flat variant list; sold-out combinations
  disabled; keyboard + screen-reader support.
- **Tests:** DOM tests for 1/2/3-option products, sold-out states.

### 1.6 Out-of-stock handling
- **Widget:** unavailable variants disabled everywhere; if the chosen variant is
  unavailable the bar shows "Sold out" and the widget stops setting quantity
  (theme's own sold-out button stays in charge). No inventory counts are exposed.

### 1.7 Variables incl. 4 metafield variables
- **Model:** `DealConfig.metafieldVars: { name, namespace, key }[]` (max 4).
- **Liquid:** loops the published list and renders
  `product.metafields[ns][key].value` into the data JSON.
- **core:** one variable table used by widget + admin preview:
  `quantity, buy, get, price, full_price, unit_price, compare_price, saved_amount,
  saved_percentage, discount, product` + metafield names.

### 1.8 Upsells from complementary products
- **Model:** `Upsell.source: "product" | "complementary"`, `limit`.
- **Widget:** `GET /recommendations/products.json?product_id=…&intent=complementary`.
- **Function:** must still bind the discount to real products (0.1). Read the main
  product's `shopify--discovery--product_recommendation.complementary_products`
  metafield in the input query and accept only those products *(verify metafield
  access from Functions)*; fallback: publish the list per targeted product at sync.

### 1.9 Extra % on BXGY ("Buy 3 get 4 + 10%")
- **Model:** `Bar.extraPercent`.
- **core/Function:** compute one combined fixed amount per line (free units + % on
  the rest) instead of two candidates on the same line *(verify stacking rules;
  a single candidate per line avoids the question)*.

### 1.10 Custom element + events
- **Widget:** `customElements.define("cartlift-bundle")`; attributes
  `product-id`, `product-handle`. Must sit inside a product form (same as Kaching).
  Product data: `/products/<handle>.js`; collections via the app proxy (6.3).
- **Events** on the widget root: `cartlift:bar-selected` (exists),
  `cartlift:variant-selected`, `cartlift:variants-changed`
  `{ variantIdQuantities, price, formattedPrice }`. Document them.

### 1.11 Preview on a real product
- **Admin:** product picker in the preview card; loader fetches title, variants,
  prices, images, options/swatches via Admin GraphQL and builds the same `ctx`
  the Liquid snippet produces. Remember the last previewed product per deal.

**Exit:** every row in PARITY 1.2 / 1.3 ✅; scopes batch released.

---

## Phase 2 — Templates

### 2.1 Mix & match (quantity breaks for different products)
- **Model:** `DealConfig.mixMatch = { enabled, eligible: "selected"|"collections"|"except", productIds, collectionIds, modal: { style…, photoSize, showNames, priceDisplay: "selected"|"main" } }`.
  Store collection **handles** in `ResourceRef` (needed on the storefront).
- **Widget:** "Choose products" slots per unit → modal (lazy chunk) listing
  eligible products: `/collections/<handle>/products.json` or `/products.json`,
  paginated, with search; variant pick inside the modal; adds all lines with
  `_cartlift=<deal>`.
- **Function:** already counts across products when `across` is set ✔; eligibility
  must use the mix-match set.
- **Tests:** core tests for mixed carts; DOM tests for the modal.

### 2.2 Complete the bundle ("Bundle upsell" bar)
- **Model:** `Bar.kind = "bundle"`, `Bar.items: { variant, qty, discountType, discountValue }[]`
  (the main product is always item 0).
- **Widget:** renders the items with images and checkboxes/pickers; adds every
  line tagged `_cartlift_bundle=<deal>:<bar>`.
- **Function:** find complete sets = min over items of `floor(lineQty / item.qty)`;
  discount each component per its own rule for complete sets only; verify every
  tagged line's variant belongs to the bar (0.1 rule).
- **Tests:** partial set → no discount; two sets; foreign product tagged.

### 2.3 Progressive gifts
- **Model:** `Bar.gifts: VariantRef[]` (migrate `gift` → `gifts[0]` in `normalizeConfig`).
- **Function/watcher/core:** gift sets per reached bar (watcher already reconciles).
- **Widget:** "gift track" component: every tier's gifts, locked/unlocked states.
- **Template:** seeds 3 bars with gifts at 2 and 3 units.

### 2.4 Template gallery
Six cards (quantity breaks, BXGY, mix & match, complete the bundle, progressive
gifts, subscription — disabled until 5.4), each seeding config via `templateBars`.

**Exit:** PARITY 1.1 ✅ except subscription rows.

---

## Phase 3 — Analytics 2.0 + A/B testing

### 3.1 Richer events
- **Widget:** lines carry `_cartlift_bar`; beacons carry bar + product
  (`{ t, d, a, b, p }`); a `cartlift_seen` flag in localStorage marks visitors who saw a deal.
- **Pixel:** reads the flag via `browser.localStorage` so orders from deal
  viewers count as eligible even without deal lines; reports per-line
  variant, quantity, bar, price, and whether it had a selling plan.

### 3.2 Model
- `StatFact` (replaces `DailyStat` after backfill): `shopId, dealId, arm, barId ("" = deal-level), productId (0 = none), day` + `views, addToCarts, checkouts, orders, eligibleOrders, units, revenue, addedRevenue, cost, subscribedOrders`.
- `DealOrderLine` (orderId, dealId, variantId, qty, revenue) for cost and product tables.
- `VariantCost` cache (variantId → unitCost, refreshed daily with a bulk operation; `read_inventory`).
- Day buckets in the **shop's timezone** (`shop.ianaTimezone`), not UTC.
- `/api/events` hardening: per-IP + per-shop rate limit, ignore unknown bars/products, cap values.

### 3.3 Metrics (15)
Revenue, added revenue, bundle orders, visitors, CR, AOV, revenue/visitor,
profit/visitor, profitability, ATC, ATC rate, checkout rate, subscribed count,
subscription rate, UPT — formulas in one module shared by dashboard, analytics and CSV.

### 3.4 Analytics UI
Custom date range; comparison period (previous period, dotted line, % change);
chart (hand-rolled SVG or a small chart lib, following the dataviz guidance);
tables Bundles / Bars / Features / Products with selectable KPI columns;
17-column CSV. Use the `dataviz` skill when building the chart.

### 3.5 A/B testing
- **Model:** `DealConfig.abTest = { status: "off"|"running"|"ended", weights: {A,B,C,D}, arms: { B: Partial<DealConfig>, … }, startedAt, winner }` — arms override anything except targeting and schedule.
- **Admin:** "Variants" tabs in the editor (duplicate A → edit), split sliders,
  start/stop, results card with CR per arm, z-test, "needs ≥10 orders per arm",
  "no clear winner", "Apply winner" (copies the arm into A and ends the test).
- **Sync:** storefront publishes each arm's full resolved config; Function gets
  `arms: { B: FnBar[] }` (shape already supported) — unify the widget on the same keys.
- **Widget:** existing sticky `pickArm` (localStorage), weights from config.
- **Stats:** two-proportion z-test vs A on visitor conversion; p < 0.05 and ≥10
  orders in each compared arm; `core` implementation with unit tests.
- Put "A/B testing" back in plan copy.

**Exit:** PARITY 1.9 ✅ (subscription metrics wired, populated in Phase 5).

---

## Phase 4 — Design system

### 4.1 Style controls
`DealStyle` gains typography (title/subtitle/price sizes and weights), border
width, bar gap/padding, image size, gift/upsell colours, "plain" layout. All map
to CSS variables in `cartlift.css`; editor groups them like Kaching's
"Settings & style".

### 4.2 Preset themes and Brand Colors
- Presets: static palettes applied to `style.colors`.
- **Brand Colors:** `Shop.settings.brandPalette = { neutrals, accents, badge, alerts }`.
  Scan = read the live theme's `config/settings_data.json` (`read_themes` ✔,
  already used by `theme.server.ts`) → colour schemes → heuristics into groups;
  merchant edits with pickers + live preview.
- Linking: a colour value may be `brand:accents.0`; resolved at sync, so editing
  the palette republishes every linked deal.

### 4.3 Savings Summary Bar
- **Model:** `DealStyle.savingsBar = { enabled, text, includeGifts, colors, border, icon, align, size }`.
- **Widget:** below the bars; value = selected bar saving (+ gift value, + upsell
  savings when checked); hidden when zero; updates on every change.

### 4.4 Custom HTML, per-deal CSS, bar ordering
Custom HTML slots above/below the widget (merchant-owned content, rendered as is);
per-deal CSS scoped to `[data-deal="…"]`; drag-and-drop bar ordering in the editor.

### 4.5 Optional — sticky add-to-cart
Only third-party sources claim Kaching has it. If built: IntersectionObserver on
the product form; fixed bar with the selected tier and a button that submits the form.

**Exit:** PARITY 1.4 ✅.

---

## Phase 5 — International & subscriptions

### 5.1 Storefront translations
- **Model:** `DealTranslation` table (dealId, locale, JSON of bar/upsell/gift/
  highlight/block-title strings) + shop-level widget strings ("each", "Sold out",
  "+ FREE gift", modal labels…).
- **Sync:** one metafield per locale `cartlift/i18n_<locale>`; Liquid reads
  `app.metafields.cartlift[key]` for `request.locale.iso_code` — keeps the main config small.
- **Admin:** "Translations" screen per deal; store languages via `shopLocales` (`read_locales`).
- **Auto-translate:** server action calling the Claude API (Sonnet), keeping
  `{{variables}}` intact, merchant reviews before saving. Load the `claude-api`
  skill when implementing (model ids, caching, cost).

### 5.2 Markets
- **Model:** `Deal.markets: string[]` (empty = all).
- **Admin:** Markets dropdown under Visibility (`read_markets`).
- **Sync:** resolve markets → country codes; Function checks
  `localization.country.isoCode` ✔ (Input's `market` field is deprecated ✔).
- **Widget:** Liquid passes `localization.country.iso_code`; deals filtered the same way.
- Kaching's per-market pricing = duplicate the deal per market; keep that workflow.

### 5.3 Admin in 9 languages
Extract all admin strings into `app/locales/<lang>.json` (EN, FR, DE, ES, IT, NL,
SV, TR, PT-BR); locale from App Bridge / session; draft translations with Claude,
human review; lint rule against hard-coded strings in routes.

### 5.4 Subscriptions
- **Model:** `DealConfig.subscription = { enabled, position, title, defaultSelected, style }`;
  `Bar.subscriptionDiscount`; `Upsell.forSubscribers`; gift `recurring: boolean`.
- **Widget:** subscribe / one-time choice using `product.selling_plan_groups`
  from the product JSON; lines carry `selling_plan`.
- **Function:** CartLine `sellingPlanAllocation` ✔ available → subscription pricing.
- **Discount:** set `appliesOnSubscription` / `appliesOnOneTimePurchase` /
  `recurringCycleLimit` on the automatic discount ✔ fields exist *(verify recurring
  behaviour — community reports inconsistencies)*.
- **Gifts:** one-time gift = line without selling plan; recurring = with.
- **Metrics:** subscribed orders/rate from the pixel flag (3.1).
- **Tests:** Shopify Subscriptions app + Loop on the dev store.

**Exit:** PARITY 1.5 ✅ and subscription rows ✅.

### 5.5 How it was actually built (2026-09-23)
- **Translations** live in the deal's own config (`config.translations[locale]`)
  and in shop settings (`settings.i18n[locale]`) rather than a new table — one
  less migration, and a deal carries its texts when it is duplicated. Publishing
  writes one `cartlift/i18n_<locale>` metafield per language; a language whose
  texts are all removed is cleared on the next publish (`settings.locales`
  remembers what was published). The widget swaps texts in `packages/widget/src/i18n.ts`
  and falls back to the written text everywhere.
- **Auto-translate** is `app/lib/translate.server.ts` (Claude API, effort "low",
  `CARTLIFT_TRANSLATE_MODEL` to override). A translation that lost or renamed a
  `{{variable}}` keeps its source text. Needs `ANTHROPIC_API_KEY` on the server.
- **The admin's nine languages** are keyed by the English source text
  (`app/lib/admin-i18n.tsx` + `app/locales/<lang>.json`), so a missing or
  outdated translation shows English instead of a key, and texts that come from
  `app/lib` (template titles, metric and plan names) translate through the same
  dictionary. The language follows Shopify's `?locale=`.
- **Subscriptions** turned out simpler than the plan: instead of a subscription
  discount per bar, the *plan's price* is the price every bar is computed from,
  which is what a shopper sees anyway. `subscriptions.apply` ("both" /
  "subscription" / "onetime") is enforced in the Function and mirrored in the
  cart watcher, so tiers can't be filled by purchases the deal doesn't price.
  Gifts are always one-time. No `appliesOnSubscription` field exists on
  `DiscountAutomaticAppInput`, and Function discounts already reach subscription
  lines, so nothing extra is set on the discount — note that the Function is not
  re-run for recurring orders.
- **Still open:** upsells "for subscribers only" beyond what `apply` gives;
  server-side validation messages are still English; untested against a live
  subscription app.

---

## Phase 6 — Billing & ecosystem

### 6.1 Plans
*(2026-09-23: the four FLEX tiers were removed again — the plans now stop at Pro.
The database enum keeps them because Postgres cannot drop an enum value, and
`RETIRED_PLANS` maps them onto Pro.)*

Seven tiers ($14.99 → $299, caps $1K → $50K+), annual variants, 7-day trial,
dev stores free — configured in the Partner dashboard, mirrored in `plans.ts`
(handles + `planFor` suffixes already handle `-annual`).
**Decided 2026-09-22:** keep the Free plan. Scope batch in Phase 1 approved.
**Still open at phase start:** Kaching auto-upgrades and bills overage. Managed
pricing needs merchant approval per change, so either keep "prompt to upgrade"
(current) or switch to the Billing API (`appSubscriptionCreate` with a capped
usage line + monthly `appUsageRecordCreate` for overage).

### 6.2 Page builders, cart drawers, variant apps
- Test matrix: PageFly, GemPages, EComposer, Foxify, Instant, Replo (app block or
  custom element), UpCart and 2–3 popular drawers (watcher refresh adapters per
  drawer, next to the Dawn/`cart:refresh` handling), 2048 Variants and a
  variant-image app (follow their variant input).
- Publish a help page per integration.

### 6.3 App proxy + headless
- **App proxy** `/apps/cartlift/*` (configured in `shopify.app.toml`, HMAC-verified):
  `config` (deals for a product incl. collection membership) — also used by the
  custom element (1.10).
- **`@cartlift/react`** package: renders from `packages/core`, adds via Storefront
  API `cartLinesAdd` with line attributes; Hydrogen example app.

**Exit:** PARITY 1.8 ✅ and billing rows ✅.

---

## Phase 7 — AI assistant

- **Admin:** "Assistant" page and an editor side panel; streaming chat.
- **Server:** Claude API with tools bound to the app's own functions:
  `list_deals`, `get_deal`, `create_deal_draft`, `update_deal_draft`,
  `diagnose(productUrl)` (embed status, deal live/targeting/market checks),
  `translate_deal`. Screenshot input (vision) and competitor URL (server fetch +
  extract tiers) produce a draft deal.
- **Guardrails:** assistant only creates drafts; merchant confirms before publish;
  per-plan rate limits; no customer data sent. Load the `claude-api` skill when implementing.

**Exit:** PARITY 1.10 ✅ → 100%.

### 7.5 How it was actually built (2026-09-23)
- **No tool-calling loop.** Each job is one request that must answer with JSON:
  a deal from a prompt, from a page's text, from a screenshot, or a rewrite of
  the open deal. That is cheaper, predictable, and easy to validate — and the
  thing a merchant wants is a draft to look at, not an agent with write access.
- **The model never writes to the store.** Drafts are saved `DRAFT`; the editor
  panel changes the form, not the database. Everything passes through
  `normalizeConfig` + `validateConfig` first, so an odd answer is an error.
- **The prompt was tuned against the real API**, which caught three faults a
  test with a mocked answer never would: a quantity break typed as a BUNDLE, a
  free gift silently dropped, and "buy one get one free" written as an invalid
  BXGY bar. The rules about types, gifts and `qty`/`get` in `SYSTEM` are the fix.
- **Reading a page the merchant names** happens on our server, so `safeUrl`
  refuses anything but public http(s) — in particular `169.254.169.254` and the
  private ranges — and the final URL after redirects is checked again.
- **Cost** is held down by plan gating plus a daily count in `Shop.settings.ai`,
  the small model for translation and the big one only for writing deals, and by
  sending the model a trimmed config (no colours, arms or translations) on edits.

---

## After parity — differentiators (optional)
- Customer-tag targeting: Function input exposes
  `cart.buyerIdentity.customer.hasAnyTag` ✔; widget uses `customer.tags` in Liquid.
- Draft orders: ✔ partially supported for functions without network access (ours has none) — test and document.
- Keep Buy-it-now for multi-line bundles via a cart permalink.
