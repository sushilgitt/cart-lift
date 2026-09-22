# CartLift ↔ Kaching Bundles — parity audit & roadmap

Audited 2026-09-22 against the live listing (https://apps.shopify.com/bundle-deals),
the Kaching help center (https://support.kachingappz.com, Bundles collection) and
kachingappz.com. Items only claimed by third parties are marked *(unverified)*.

**Scope.** "Kaching Bundles App & Upsells" only. Kaching's sibling apps — Cart
Drawer AI Upsell, Post-Purchase Upsell, Subscriptions, Popups, Custom Cursor —
are separate installs and out of scope. We copy features and behaviour, never
Kaching's name, branding, UI artwork or help-center text.

**Where we are:** ~50% of the full feature set (the 2026 additions — Analytics
2.0, Savings bar, Brand Colors, AI assistant, swatches, 7 billing tiers — widened
the gap). The core flow a typical merchant uses (quantity breaks + gift/upsell on
the product page, priced by a Function) is ~90%.

Legend: ✅ done · 🟡 partial · ❌ missing

---

## 1. Feature comparison

### 1.1 Deal templates & discount types
| Kaching | CartLift | Notes |
|---|---|---|
| Quantity breaks, same product | ✅ | |
| Buy X get Y — Y free / % / amount / fixed price, Y shows $0 | ✅ | |
| Mix tiers of different types in one deal | ✅ | Bar type per bar |
| Quantity breaks for different products (choose-product modal with its own style) | ✅ | Pool: visibility / products / collections / all-except; chooser with search |
| Complete the bundle — "Bundle Upsell" bar: hand-picked products/variants, each with own discount | ✅ | Complete sets only |
| Progressive gifts template *(template name unverified)* | ✅ | Several gifts per bar, cumulative option, gift track |
| Subscription template / per-deal subscription toggle | ❌ | Selling plans not supported |
| Collection breaks — tiers apply however the product is added (widget, product form, collection page) | ✅ | Function counts untagged lines; gifts follow the cart (c9bb318) |
| Collection breaks — merge duplicate variant lines into one | ✅ | Cart watcher merges a plain line into the deal line |
| Same quantity allowed on two bars only with the same discount | ✅ | Picked bar is tagged; its gift/message apply |
| Additional % on top of BXGY ("Buy 3 get 4 + 10%") | ✅ | |

### 1.2 Bar settings
| Kaching | CartLift |
|---|---|
| Title, subtitle, label, badge (simple/fancy), selected by default | ✅ |
| Discount % / amount per item / custom total | ✅ |
| Bar image | ✅ uploaded to Shopify Files |
| Highlights (callouts / trust text per bar) | ✅ up to 4 |
| Free gift per bar | ✅ |
| Upsell per bar — selected product, adjusted price, text, image, pre-checked, only when bar selected | ✅ |
| Upsell source: Shopify complementary products | ✅ Search & Discovery; Function-checked |
| Upsell "enable for subscription customers" | ❌ |
| Subscription pricing option per bar | ❌ |
| Discount name shown in cart/checkout (override) | ✅ |
| Dynamic variables incl. 4 custom product-metafield variables | ✅ 11 built-ins + 4 metafield variables |

### 1.3 Variants
| Kaching | CartLift |
|---|---|
| Different variant per unit | ✅ |
| "Show product variants selection" on single-quantity bars (toggle) | ✅ |
| Default variants per bar / per product | ✅ per bar, filtered to the viewed product |
| Swatches: colour, uploaded image, variant image; shape circle/rounded/square; size slider | ✅ option-based pickers |
| Hide theme quantity selector | ✅ |
| Out-of-stock variants disabled | ✅ pickers, swatches and a "Sold out" bar state |
| Follow theme variant picker | ✅ |

### 1.4 Widget design
| Kaching | CartLift |
|---|---|
| Layouts vertical / horizontal / grid | ✅ |
| Colours for bar, selected bar, borders, title, subtitle, prices, label, badge, block title | ✅ (14 tokens) |
| Typography & sizing (font sizes/weights, borders, spacing) | ✅ |
| Preset colour themes (e.g. purple, lime, orange, black) *(from third-party review)* | ✅ |
| Brand Colors — scan storefront → palette (Neutrals, Accents, Badge, Alerts), linked to deals | ✅ theme scan; links resolved at publish |
| Savings Summary Bar ("You're saving $X", live, optional gift value, own styling) | ✅ |
| Compare-at price × quantity | ✅ |
| Custom CSS | ✅ shop-wide and per deal (scoped) |
| Custom HTML *(listing tag)* | ✅ above/below; scripts stripped in the admin preview |
| Live preview | ✅ real product with switching |
| Sticky ATC / countdown / scratch-off *(third-party only, unverified)* | ❌ optional |

### 1.5 Text, languages, markets
| Kaching | CartLift |
|---|---|
| Storefront translations per store language, manual + Auto-translate | ❌ |
| Markets dropdown per deal | ❌ |
| Money formats from Shopify, multi-currency | ✅ |
| Admin in EN, FR, DE, ES, IT, NL, SV, TR, PT-BR | ❌ English only |

### 1.6 Discount mechanics
| Kaching | CartLift |
|---|---|
| One automatic product discount via Function | ✅ |
| Combines with order + shipping, not product discounts on same line | ✅ |
| Buy-now hidden for multi-line bundles | ✅ |
| Shopify POS | 🟡 untested |
| Subscriptions / selling plans (Loop, Kaching Subscriptions compatible) | ❌ |

### 1.7 Targeting & scheduling
| Kaching | CartLift |
|---|---|
| All / selected / collections / all-except | ✅ |
| Start & end schedule | ✅ |
| Markets | ❌ |
| Up to 250 products per deal | ✅ |

### 1.8 Placement & integrations
| Kaching | CartLift |
|---|---|
| App embed auto-inject | ✅ |
| App block with dynamic product source (also in Featured product) | ✅ |
| Custom element `<…-bundle product-id>` inside product form | ✅ `<cartlift-bundle>` |
| JS events: bar selected / variant selected / variants changed (with quantities + price) | ✅ |
| `?…=off` debug switch | ✅ |
| Page builders: PageFly, GemPages, EComposer, Foxify, Instant, Replo | ❌ untested |
| Cart drawers: UpCart | ❌ untested |
| Headless: Hydrogen package, React package | ❌ |
| 2048 Variants, Rubik Variant Images compatibility | ❌ untested |

### 1.9 Analytics & A/B
| Kaching (Analytics 2.0) | CartLift |
|---|---|
| Revenue, added revenue, bundle orders, visitors, CR, AOV, revenue/visitor, ATC, ATC rate | ✅ |
| Units per transaction | ✅ |
| Checkout rate | ✅ |
| Profit/visitor, profitability (needs product cost) | ✅ unit cost via read_inventory |
| Subscribed count / subscription rate | ✅ tracked (subscriptions ship in Phase 5) |
| Chart over time with comparison period + % change | ✅ |
| Custom date range | ✅ |
| Tables: Bundles (custom KPI columns), Bars, Features, Products | ✅ |
| CSV export (17 daily columns) | ✅ same columns |
| A/B: up to 4 variants, even/custom split, sticky per visitor, z-test on CR, ≥10 orders/arm, winner | ✅ apply winner |

### 1.10 Admin, AI, billing
| Kaching | CartLift |
|---|---|
| Dashboard with added revenue, templates page, onboarding | ✅ |
| "Ching" AI assistant — build from prompt/screenshot/URL, edit in plain English, diagnose setup, translations | ❌ |
| Plans on added revenue: $14.99 / $29.99 / $59.99 (+ monthly caps) | ✅ |
| Flex tiers $99 / $149 / $199 / $299 (to $50K+) | ❌ |
| Annual plans (~27% off), 7-day trial | ❌ (Partner dashboard config) |
| Dev stores free, no free production plan | 🟡 we offer a Free plan ($250 cap) |
| Auto-upgrade when cap passed | ❌ (needs merchant approval under managed pricing — see Phase 6) |
| Keep deals after uninstall / restore | ✅ (until shop/redact) |

---

## 2. Phase plan

Each phase closes whole areas of the table above, so at the end of a phase
every row in that area matches Kaching, the app is releasable, and the
recording/review checklist still passes. Parity % is the cumulative estimate.

Rules for every phase:
- Pricing maths lives in three places today (`app/lib/deals.ts`, `cartlift.js`,
  the Function). Phase 0 moves it into one shared `packages/core`; from then on
  every pricing change goes there, with tests.
- New Function behaviour ships with tests in `extensions/cartlift-discount/tests`.
- Exit = feature checklist done + dry-run on Dawn + one non-Dawn theme +
  `npm run deploy` + Coolify redeploy.

### Phase 0 — Align & harden (≈2 weeks) → ~52%  ✅ released 2026-09-22 (cartlift-4, cartlift-5)
Still open: 0.6 manual checks — POS on a device, storefront smoke on Dawn + one other theme.
Make what exists behave exactly like Kaching before adding more.
How each item is built: [`IMPLEMENTATION.md`](IMPLEMENTATION.md).
- **Security:** bind upsell discounts to the configured product (today any
  product tagged `_cartlift_upsell` gets the upsell price).
- Shared pricing core package + TypeScript widget build (used by every later phase).
- Remove "A/B testing" from plan copy until Phase 3 ships.
- Duplicate quantities allowed when the discount matches; clear error otherwise.
- Merge duplicate variant lines of the same deal (collection-breaks behaviour).
- Show units per order; add `checkout_started` to the pixel → checkout rate.
- Verify POS pricing and document it; verify on 2–3 popular themes.
- Unit tests for the widget's pricing (`priceBar` parity with the Function).

### Phase 1 — Bars & variants (≈3 weeks) → ~62%  ✅ built 2026-09-22
Closes 1.2 and 1.3.
- Bar image; bar highlights.
- Variant picker on single-quantity bars (toggle); default variants per bar/product.
- Swatches: colour / uploaded image / variant image, 3 shapes, size slider;
  out-of-stock state on swatches, pickers and bars that can't be fulfilled.
- Full variable set + 4 product-metafield variables.
- Upsell source "complementary products" (Search & Discovery).
- Additional % on top of BXGY bars.
- Custom element placement; `variant-selected` and `variants-changed` events.
- Admin preview on a real product with product switching.

### Phase 2 — Templates (≈3–4 weeks) → ~72%  ✅ built 2026-09-22
Closes 1.1 (except subscriptions).
- **Mix & match:** storefront choose-product modal (eligible = selected /
  collections / all-except), styled from the editor; photo size, names, price
  display modes; Function counts across chosen products.
- **Complete the bundle:** new "Bundle upsell" bar type with hand-picked
  products/variants and a discount each; Function prices each component.
- **Progressive gifts:** template + gift progress track in the widget.
- Template gallery with all six templates (Subscription greyed until Phase 5).

### Phase 3 — Analytics 2.0 + A/B testing (≈3–4 weeks) → ~80%  ✅ built 2026-09-22
Closes 1.9.
- Track bar and product per event (views, ATC, orders) — schema: `DailyStat` gains
  `barId`, new `ProductStat`.
- All 15 metrics (subscription ones light up in Phase 5; profit needs product
  cost → `read_inventory` scope for `InventoryItem.unitCost`).
- Chart with comparison period and % change; custom date range; Bundles / Bars /
  Features / Products tables with selectable KPI columns; 17-column CSV.
- A/B: editor for 2–4 variants of a deal (anything except visibility/schedule),
  even or custom split, publish arms to widget + Function (unify the arm shape),
  z-test on CR with ≥10 orders/arm, "winner / no clear winner", apply winner.
- Put "A/B testing" back on the plans.

### Phase 4 — Design system (≈2 weeks) → ~85%  ✅ built 2026-09-22 (sticky add-to-cart not built: unverified in Kaching)
Closes 1.4.
- Typography (sizes, weights), borders, spacing, image sizes, gift/upsell colours.
- Preset colour themes; **Brand Colors**: scan the live theme's settings/CSS into
  a palette (Neutrals, Accents, Badge, Alerts), linked to deals, "apply to deal".
- **Savings Summary Bar** with its styling options and gift-value toggle.
- Custom HTML slot; per-deal custom CSS; drag-and-drop bar ordering.
- Optional (unverified in Kaching docs): sticky add-to-cart.

### Phase 5 — International & subscriptions (≈3–4 weeks) → ~93%
Closes 1.5, and the subscription rows of 1.1, 1.2 and 1.6.
- Storefront translations for every published store language
  (`request.locale`), manual editor + Auto-translate (LLM-backed).
- Markets per deal (`read_markets`); Function reads the cart's market; widget
  reads `localization.market`.
- Admin UI in the 9 Kaching languages.
- Subscriptions: per-deal toggle, subscribe/one-time choice in the widget using
  the product's selling plans, subscription pricing per bar, upsells for
  subscribers, gifts one-time vs recurring; test with Shopify Subscriptions and Loop.
- Subscribed count / rate metrics.

### Phase 6 — Billing & ecosystem (≈2–3 weeks) → ~97%
Closes 1.8 and billing rows of 1.10.
- Plans: 7 tiers to $299, annual variants, 7-day trial, dev stores free.
  **Decided 2026-09-22: keep CartLift's Free plan** (a deliberate difference from Kaching). Kaching auto-upgrades; managed pricing needs merchant
  approval, so either prompt to upgrade (current) or move to the Billing API
  with usage charges — decide at phase start.
- Compatibility pass + help docs: PageFly, GemPages, EComposer, Foxify, Instant,
  Replo, UpCart, 2048 Variants, variant-image apps.
- Headless: React component package and Hydrogen example.

### Phase 7 — AI assistant (≈3 weeks) → ~100%
Closes the AI row of 1.10.
- In-admin assistant (Claude API): create a deal from a prompt, a screenshot or a
  competitor URL; edit a deal in plain English; diagnose "not showing" issues
  (embed off, deal paused, targeting, market); help with translations and market pricing.

**Total:** roughly 21–25 developer-weeks. Phases 3–7 can be reordered by
business priority; 1 → 2 is a hard dependency (bundle-upsell needs the bar model
changes), and 5's subscription metrics depend on 3's analytics schema.
