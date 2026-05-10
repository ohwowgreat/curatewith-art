# curatewith.art

A collaborative art browsing tool built on open museum collections. Browse hundreds of thousands of artworks from five institutions, search across all of them at once, and build a shared "curate together" board in real time with anyone in the same room.

Inspired by [Jess Yin's enterportal.xyz](https://enterportal.xyz).

## What it does

**Search** — full-text search across MoMA, The Met, Art Institute of Chicago, Cleveland Museum of Art, and National Gallery of Art simultaneously. Results pull from Redis-indexed open-access collection data seeded from each museum's public API.

**Curate together** — a shared four-slot board synced in real time via WebSocket. Anyone visiting the same URL sees the same board and can add or swap artworks. Online presence (names, visitor count) is shown live in the nav.

## Stack

- **Frontend** — single-file `public/index.html`, vanilla JS, no build step
- **Backend** — `party/server.ts`, a [PartyKit](https://partykit.io) edge server handling both HTTP artwork queries and WebSocket room state
- **Database** — [Upstash Redis](https://upstash.com) (REST API), shared with museum seed data
- **Proxy** — `worker.js`, a Cloudflare Worker that routes `curatewith.art` to the PartyKit deployment

## Museum data

All collections are open-access. Seed scripts in `scripts/` pull from each museum's public API and write into Redis.

```bash
UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... node scripts/seed-moma.mjs
UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... node scripts/seed-met.mjs
UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... node scripts/seed-aic.mjs
UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... node scripts/seed-cma.mjs
UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... node scripts/seed-nga.mjs
```

## Deploy

```bash
# PartyKit server
npx partykit deploy

# Cloudflare proxy worker
npx wrangler deploy
```

Required env vars (set via `npx partykit env add KEY`): `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`
