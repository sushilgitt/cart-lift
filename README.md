# CartLift

Quantity breaks, BOGO, free gifts and upsells for Shopify product pages — a
feature-by-feature rebuild of Kaching Bundles. See `docs/PLAN.md` for the
architecture and roadmap and `docs/RESEARCH.md` for the functional spec.

## Stack
- React Router app template, Polaris web components, Prisma + Postgres
- `extensions/cartlift-discount` — Shopify Discount Function (checkout pricing)
- `extensions/cartlift-widget` — theme app embed + app block (storefront widget)
- `extensions/cartlift-pixel` — web pixel for order attribution

## Develop
```sh
npm install
npm run dev                  # shopify app dev
cd extensions/cartlift-discount && npx vitest run   # function tests
```

## Environment
| Variable | |
|---|---|
| `SHOPIFY_API_KEY` | Client ID |
| `SHOPIFY_API_SECRET` | Client secret (never commit) |
| `SHOPIFY_APP_URL` | Public URL, e.g. https://cartlift.91.239.208.85.sslip.io |
| `SCOPES` | Same as `shopify.app.toml` |
| `DATABASE_URL` | Postgres connection string |
| `CARTLIFT_AI_KEY` | Auto-translate and the deal assistant. Without it the rest of the app works and the AI features say the key is missing. `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` are read too. |
| `CARTLIFT_AI_PROVIDER` | `openai-compatible` (default) or `anthropic`. |
| `CARTLIFT_AI_BASE_URL` | Any OpenAI-compatible endpoint; default `https://api.openai.com/v1`. |
| `CARTLIFT_AI_MODEL` | Short jobs (translation). Default `gpt-5.4-mini`. |
| `CARTLIFT_AI_MODEL_BIG` | The assistant. Default `gpt-5.4`. |

## Support
`/app/support` is in-app support: the merchant asks, and CartLift answers from
`app/lib/support-kb.ts` plus facts about their own shop (plan, embed on/off, how
many deals are live). Anything it can't answer is flagged `needsHuman` on the
thread. The app offers merchants no way to reach a person, so nothing in it
promises one — the support address on the App Store listing is that route. **`support-kb.ts` is the only thing support
knows — when the app changes, change it in the same commit, or merchants get
confidently wrong answers.** Without an AI key the page still works: every
message is stored and marked for a person.

## Headless and compatibility
- `packages/headless` — deal matching, pricing and the cart lines checkout
  expects, for storefronts that render their own product page; `examples/hydrogen`
  shows it in a Hydrogen route.
- `docs/COMPATIBILITY.md` — how the widget places itself, how it survives page
  builders, and the `window.CartLift.onCartUpdated` hook for cart drawers.

## Plans (Shopify managed pricing)
Prices, trials and annual options live in the Partner dashboard; `app/lib/plans.ts`
only mirrors them. Each plan needs a handle that matches, and an annual variant
named `<handle>-annual` (a year is ten months' money, which the plans page
works out and shows as "save 16%"):

| Handle | Monthly | Yearly (`<handle>-annual`) | Added revenue / month |
|---|---|---|---|
| `free` | $0 | — | $250 |
| `starter` | $14.99 | $149.99 | $1,000 |
| `scale` | $29.99 | $299.99 | $5,000 |
| `pro` | $59.99 | $599.99 | $10,000 |

Set a 7-day trial on every paid plan (`TRIAL_DAYS` in `plans.ts` only *says* 7).
The `Plan` enum in the database also carries four retired FLEX tiers, because
Postgres cannot drop an enum value; `RETIRED_PLANS` maps them onto Pro.
Development stores are free: `Shop.devStore` comes from `shop.plan.partnerDevelopment`
and skips the limit and its banners. Going over a limit never pauses deals — the
merchant is shown the plan that would cover the month.

## Deploy
- App server: Coolify (Dockerfile build from `main`).
- Extensions + app config: `npx shopify app deploy --allow-updates`.
- Order: extensions first, then the server — a new Function reads the config the
  old server publishes, but not the other way round.
