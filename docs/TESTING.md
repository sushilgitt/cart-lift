# Testing CartLift

The build is done; none of it has served a real shopper. This is the order to
find that out in, worst-consequence first: a deal that looks perfect but charges
the wrong amount at checkout is the bug that loses merchants, so it is tested
before anything cosmetic.

**How to use this:** work a phase at a time and don't start the next until the
current one passes. Write failures down as you go (phase, steps, what you
expected, what happened, screenshot). Re-run Phase 2 at the end as a regression
pass, because it is the one everything else can break.

Automated tests already cover the arithmetic, the cart-line contract and the
admin's plumbing (`npm test`). Among them, `app/lib/money-path.test.ts` walks
Phase 2 in simulation: it drives the real widget, takes the cart lines it posts,
runs them through the real Discount Function and checks the shopper is charged
what the bar said. Run it before you start — if it fails, don't bother opening a
product page. It cannot see themes, taxes or Shopify's own discount stacking,
which is exactly why Phase 2 below is still done by hand. What no test can
cover is a real theme, a real checkout and a real shopper, which is all this
document is about.

---

## Phase 0 — Set the dev store up

Not a test; the fixtures everything else needs. Do it once, properly.

- A **simple product** (one variant, ~$20).
- A **variant product** (Size × Colour, one variant sold out, different prices).
- A **gift product** (cheap, its own variant) and **two upsell products**.
- A **subscription product** — install Shopify Subscriptions and give it a
  selling plan. Skip only if you accept shipping subscriptions untested.
- **Search & Discovery** installed, with complementary products set on the
  simple product (that is where complementary upsells come from).
- A **second market** (e.g. Germany) and a **second storefront language**.
- A **second theme** besides Dawn, to prove placement isn't Dawn-specific.
- Confirm the shop reads as a **development store**: Plans should say CartLift
  is free here with no limit.

---

## Phase 1 — Install and foundations

| # | Do | Pass looks like |
|---|---|---|
| 1.1 | Install the app fresh | Scopes screen lists exactly what the app needs; install completes; Dashboard loads |
| 1.2 | Open every admin page | Dashboard, Deals, Assistant, Analytics, Settings, Plans, Support — no error boundary, no blank page |
| 1.3 | Settings → Theme setup | Embed state is detected correctly. Turn it off and reload: the admin notices |
| 1.4 | Save your first deal | A single **automatic discount** appears in Shopify admin → Discounts, named after the app |
| 1.5 | Save again with no changes | No duplicate discount is created |
| 1.6 | Uninstall, then reinstall | Deals and settings are still there |

Stop here if 1.4 fails — nothing downstream can work without that discount.

---

## Phase 2 — The money path *(the one that matters)*

For **each** deal type, the same three numbers must agree: what the **widget**
shows, what the **cart** shows, and what **checkout** charges.

| # | Deal | Check |
|---|---|---|
| 2.1 | Quantity breaks (1 / 2 −10% / 3 −20%) | Each bar's price, per-unit price and "you save" are right; add each tier and compare cart + checkout |
| 2.2 | Buy X get Y (buy 1 get 1 free) | Free unit is $0 at checkout, not half off both |
| 2.3 | Mix & match | Pick different products per slot; total matches; every line is discounted |
| 2.4 | Complete the bundle | Each item takes its own discount; removing one item from the cart stops the bundle discount |
| 2.5 | Progressive gifts | Bigger tier unlocks more gifts; all appear at $0 at checkout |
| 2.6 | Fixed total price | "3 for $50" charges exactly $50 |
| 2.7 | Compare-at pricing on | The struck-through price is the compare-at, not an invented number |
| 2.8 | Two bars with the same quantity | Pick the second one: checkout applies *that* bar's discount, not the first |
| 2.9 | Variant per unit | Choose a different variant per unit; the cart has one line per variant with the right quantities |
| 2.10 | Sold-out variant | The bar shows sold out and can't be added |
| 2.11 | Multi-line offer | Buy-it-now / express buttons are hidden (they can only carry one line) |
| 2.12 | Currency | Switch the storefront to another currency: prices and savings convert correctly |

**Also check the wording at checkout**: the discount line should name the deal
in a way a shopper understands, since that is what they see on the order.

---

## Phase 3 — Gifts and the cart watcher

The watcher is the piece that runs on every page, so it gets its own phase.

- 3.1 Reach a gift tier **from the product page** → gift is added once, at $0 in checkout.
- 3.2 Reach the tier **from the cart** (raise the quantity there) → the gift
  appears without a page reload. This is the case the widget alone can't handle.
- 3.3 Drop below the tier → the gift is removed, not left behind.
- 3.4 Remove the gift by hand, then reload → it comes back (it is earned).
- 3.5 Two deals with gifts in one cart → each gift appears once, no duplicates.
- 3.6 Cart drawer: the gift shows without closing and reopening the drawer.
- 3.7 Cart page: totals are right after the gift is added.
- 3.8 Complete an order with a gift → the order shows the gift at $0.

---

## Phase 4 — Placement and themes

- 4.1 **Auto placement** (embed on, no block): widget sits above add-to-cart.
- 4.2 **App block**: add "CartLift deals" to the product template — it renders
  there and the automatic one doesn't double up.
- 4.3 **Custom element**: `<cartlift-bundle product-id="…">` in the theme.
- 4.4 **Second theme**: repeat 4.1 and a Phase 2 purchase.
- 4.5 **Quick view / quick add** (collection page): the widget does *not* hijack it.
- 4.6 `?cartlift=off` on a product URL: page loads with no widget — the first
  thing to ask a merchant reporting a conflict.
- 4.7 If you have a page builder (PageFly, GemPages…): build a product page with
  it and check the widget appears, including after changing a variant. **Untested
  territory — expect to find something here.**
- 4.8 If you have a cart-drawer app (UpCart, Slide Cart…): repeat 3.2 and 3.6.

---

## Phase 5 — Who sees a deal

- 5.1 Targeting: all products / selected / collections / all-except — each shows
  on exactly the right products.
- 5.2 Schedule: a deal starting tomorrow doesn't show; one that ended doesn't show.
- 5.3 Status: Draft and Paused never show.
- 5.4 **Priority**: two deals matching one product → the higher one wins; reorder
  with the arrows and re-check.
- 5.5 **Markets**: limit a deal to one market, then view the storefront from a
  country outside it (Shopify's country selector or a VPN) → no deal, and no
  discount at checkout either.

---

## Phase 6 — Looks and languages

- 6.1 Every style control changes what you expect: layout, sizes, weights,
  radius, spacing, images, badges, highlights.
- 6.2 Preset themes and **brand colours** (scan theme → apply) look right on both
  of your themes.
- 6.3 Savings bar, gift track, custom HTML above/below, per-deal custom CSS.
- 6.4 Mobile: check a real phone, not just a narrow window.
- 6.5 **Storefront translations**: translate a deal, switch the storefront
  language → translated texts appear; untranslated ones fall back to English.
- 6.6 **Auto-translate**: fills fields, keeps `{{variables}}`, needs saving.
- 6.7 **Admin language**: open the admin with `?locale=de` → German admin.

---

## Phase 7 — Subscriptions *(never tested against a real subscription app)*

- 7.1 Product with a selling plan: the one-time / subscribe picker appears.
- 7.2 Subscribe → every bar re-prices from the plan's price.
- 7.3 Frequency dropdown (if the plan group has several) changes the price.
- 7.4 Add to cart → the line carries the selling plan; checkout shows a subscription.
- 7.5 A gift on that tier is added as a **one-time** item, not a subscription.
- 7.6 "This deal applies to": subscriptions only / one-time only → the other kind
  gets no discount at checkout.
- 7.7 Know the limit: Shopify does **not** re-run discount functions for renewal
  orders. The deal discounts the first order. Confirm that's acceptable, and say
  so in the listing.

---

## Phase 8 — Analytics and A/B

- 8.1 View a deal, add to cart, buy → views / add-to-carts / orders appear (allow
  a few minutes for the pixel).
- 8.2 **Added revenue** matches by hand: what the shopper paid beyond one unit.
- 8.3 Comparison period and % change behave when you change the date range.
- 8.4 Bars / Products / Features tables and the CSV export.
- 8.5 A/B: start a test, check the split is sticky per visitor (two browsers),
  orders are attributed per arm, and "apply winner" copies the right variant.
- 8.6 On a Free plan shop, A/B is offered as a paid feature rather than working.

---

## Phase 9 — Billing

- 9.1 Plans page: four plans; monthly / yearly toggle shows $149.99 / $299.99 /
  $599.99 and "save 16%".
- 9.2 Choose a paid plan on a **test store** → Shopify's hosted page, 7-day trial
  stated, and the app reads the plan back afterwards.
- 9.3 Cancel → the app returns to Free.
- 9.4 Over-limit banner names the plan that would cover the month, and deals keep
  running.
- 9.5 The plan handles in the Partner dashboard match `app/lib/plans.ts`.

---

## Phase 10 — Assistant and support

- 10.1 Assistant: a prompt, a page address and a screenshot each produce a draft
  saved as **Draft** — never live.
- 10.2 A nonsense prompt produces an error, not a broken deal.
- 10.3 "Ask the assistant" in the editor rewrites the open deal; nothing is saved
  until you press Save; discard restores it.
- 10.4 Support answers a real question using your shop's state ("your embed is
  off", "0 of 2 deals active").
- 10.5 Ask about something CartLift doesn't do → it says so instead of inventing.
- 10.6 Daily limits: they exist for a reason — confirm the message is friendly.
- 10.7 Watch your OpenAI spend during this phase; it is the first time real usage
  meets a real bill.

---

## Phase 11 — Before submitting to Shopify

- 11.1 **Performance**: Lighthouse on a product page with and without the widget.
  Shopify reviews theme-extension impact; a big drop is a rejection.
- 11.2 **Accessibility**: keyboard-only selection of bars, visible focus, screen
  reader reads the selected bar.
- 11.3 **GDPR webhooks**: `customers/data_request`, `customers/redact`,
  `shop/redact` all respond 200.
- 11.4 **Uninstall**: app data handled as your privacy policy says.
- 11.5 **Privacy policy** matches reality — including that merchant text goes to
  an AI provider for the assistant, support and auto-translate.
- 11.6 **Failure states**: block the app's domain in devtools and load a product
  page — the theme must still work and the add-to-cart must still add.
- 11.7 **Staff access**: a staff account with limited permissions doesn't break
  the admin.
- 11.8 Re-run **Phase 2** end to end. It is the regression that matters.

---

## Recording the App Store video

Record after Phase 2 passes, not before. Show: install → create a deal from a
template → the deal on the storefront → add to cart → checkout showing the
discount → analytics. Keep it under two minutes and don't narrate features the
reviewer can't see happening.
