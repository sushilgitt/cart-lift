/**
 * What support is allowed to know about CartLift.
 *
 * The assistant answers merchants only from this text plus the facts about
 * their own shop that `support.server.ts` collects. Anything outside it is a
 * question for a person — that rule is in the system prompt, and this file is
 * the reason it can be kept.
 *
 * Keep it true. A wrong line here becomes a wrong answer to every merchant who
 * asks, so when the app changes, change this in the same commit.
 */
export const SUPPORT_KB = `
# What CartLift does
CartLift shows quantity-break and bundle offers on product pages ("buy 2 save 10%").
The discount is applied by a Shopify Function at checkout, not by changing prices,
so the cart and checkout always agree with what the shopper saw.

# Deal types
- Quantity breaks: tiers of the same product.
- Buy X get Y: some of the units are free or discounted.
- Mix & match: the shopper fills a tier with different products from a pool you choose.
- Complete the bundle: the product being viewed plus items you pick, each with its own discount.
- Progressive gifts: bigger tiers unlock more free gifts.
- Subscribe & save: works with a product's selling plans.

# Getting a deal on the page
1. Turn on the app embed (Settings → Theme setup, or Online Store → Themes → Customize → App embeds).
2. Create a deal and set it Active. A deal that is Draft or Paused never shows.
3. With the embed on, the widget places itself above the add-to-cart button.
   For an exact position, add the "CartLift deals" app block to the product template,
   or put <cartlift-bundle product-id="..."> in the theme where it should appear.

# Why a deal might not show
- The app embed is off.
- The deal is Draft or Paused, or its schedule hasn't started / has ended.
- The product isn't in the deal's targeting (All products / selected / collections / all except).
- The deal is limited to markets the visitor isn't in.
- Another deal higher in the list matches the same product — the first match wins,
  and deals are ordered on the Deals page with the arrows.
- The theme has no recognisable product form; use the app block or the custom element.
- Add ?cartlift=off to a product URL to load the page without CartLift and compare.

# Discounts and checkout
- CartLift uses one automatic app discount, created the first time a deal is saved.
- It combines with order and shipping discounts, but not with another product discount on the same line.
- Free gifts are added to the cart as normal lines and taken to $0 by the Function at checkout.
- Buy-it-now is hidden for offers that add more than one line, because it can only take one.
- The Function is not re-run for subscription renewal orders: a deal discounts the first order.

# Analytics
Views, add-to-carts, orders, revenue, added revenue, conversion, AOV and more,
with a comparison period. "Added revenue" is what shoppers paid beyond a single unit —
it is also what plans are billed on. Analytics come from the web pixel and the
storefront widget, so numbers appear once shoppers see and buy deals.

# A/B testing
Up to four variants of a deal, an even or custom traffic split, sticky per visitor.
A winner is called on conversion rate once each arm has enough orders.
A/B testing is on the paid plans.

# Languages and markets
Deal texts can be translated per published store language, by hand or with auto-translate,
and a deal can be limited to chosen markets. The admin itself follows the language
of the staff member's Shopify admin.

# Plans
Free ($250 added revenue/month), Starter $14.99 ($1,000), Scale $29.99 ($5,000),
Pro $59.99 ($10,000). Yearly is ten months' money: $149.99 / $299.99 / $599.99.
Every paid plan has a 7-day free trial. Development stores are free with no limit.
Going over a limit never switches deals off — CartLift says which plan would cover the month.
Billing is handled by Shopify and appears on the Shopify bill.

# Privacy
CartLift stores deal settings and aggregated statistics. It does not store customer
names, emails or addresses. Support conversations are stored so they can be answered.
`.trim();

/** Questions support should hand to a person rather than answer itself. */
export const ESCALATE_WHEN = [
  "billing disputes, refunds or invoices",
  "anything about another merchant's shop or account",
  "a bug that needs someone to look at the shop",
  "a feature that does not exist yet",
];
