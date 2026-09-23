# Shopify app development

This app is scaffolded from a Shopify app template. See the README for framework-specific details.

Use the [Shopify AI Toolkit](https://shopify.dev/docs/apps/build/ai-toolkit) for all Shopify API and platform work. If missing, install it in the agent host per that page (or `npx skills add Shopify/shopify-ai-toolkit --list` for skill-compatible hosts) — do not add tooling to this repo.

## AI features
CartLift's AI features (auto-translate, the deal assistant) go through
`app/lib/ai.server.ts`, which talks to whichever service `CARTLIFT_AI_PROVIDER`
names — an OpenAI-compatible endpoint (the default) or Anthropic. Add new AI
calls there rather than reaching for a provider SDK, so the app stays portable
and every failure reaches merchants as a sentence rather than a stack trace.
