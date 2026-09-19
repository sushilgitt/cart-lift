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

## Deploy
- App server: Coolify (Dockerfile build from `main`).
- Extensions + app config: `npx shopify app deploy`.
