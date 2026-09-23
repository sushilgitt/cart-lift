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

## Deploy
- App server: Coolify (Dockerfile build from `main`).
- Extensions + app config: `npx shopify app deploy --allow-updates`.
- Order: extensions first, then the server — a new Function reads the config the
  old server publishes, but not the other way round.
