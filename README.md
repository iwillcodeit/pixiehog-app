# nuances — PostHog Integration for Shopify

A Shopify app that integrates PostHog analytics with privacy compliance, web pixel tracking, and server-side event capture.

Forked from [PixieHog](https://github.com/celadonworks/pixiehog-app) (FSL-1.1-Apache-2.0).

## Features

- **Web Pixel tracking** via Shopify Web Pixels API — checkout, page views, cart, product events
- **Server-side webhook pipeline** — orders, refunds, cancellations, customer updates (captures POS, subscriptions, draft orders)
- **Privacy-first** — integrates with Shopify Customer Privacy API, supports anonymized/identified/consent-gated strategies
- **PostHog JS theme embed** — session replay and experiments support
- **Deduplication** — deterministic UUIDv5 prevents double-counting between client and server events
- **Multitenant** — single server handles multiple shops, each with independent PostHog config

## Setup

```bash
npm install
npx prisma generate && npx prisma migrate deploy
npm run build
npm run start
```

## Development

```bash
shopify app dev
```

## Deployment

```bash
shopify app deploy    # deploys extensions + config to Shopify
npm run docker-start  # or deploy via Railway/Fly.io/Render
```

## License

[Functional Source License (FSL)](LICENSE.md) — converts to Apache 2.0 after two years.
