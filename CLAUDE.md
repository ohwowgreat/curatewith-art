# curatewith-art – project conventions

## Git workflow

Always use feature branches. Never commit directly to `main`.

1. Create a branch before making any changes:
   ```bash
   git checkout -b feature/short-description
   ```
2. Commit changes to that branch, push, and open a PR into `main`.
3. Merging to `main` triggers auto-deploy via GitHub Actions.

## Deployment

Auto-deploys on every push to `main` via `.github/workflows/deploy.yml`.

To deploy manually:
```bash
CLOUDFLARE_ACCOUNT_ID=<id> CLOUDFLARE_API_TOKEN=<token> \
  npx partykit deploy --domain curatewith.art
```

To set Upstash env vars (one-time, persists across deploys):
```bash
CLOUDFLARE_ACCOUNT_ID=<id> CLOUDFLARE_API_TOKEN=<token> \
  npx partykit env add UPSTASH_REDIS_REST_URL --name curatewith-art

CLOUDFLARE_ACCOUNT_ID=<id> CLOUDFLARE_API_TOKEN=<token> \
  npx partykit env add UPSTASH_REDIS_REST_TOKEN --name curatewith-art
```

## Stack

- **Frontend**: single-file `public/index.html` — vanilla JS, no build step
- **Backend**: `party/server.ts` — PartyKit edge server (WebSocket + HTTP)
- **Database**: Upstash Redis REST API (shared with open-archive deployment)
- **Domain**: curatewith.art — Cloudflare DNS, PartyKit "cloud-prem" deploy
- **Museum switching**: `?museum=moma|met|aic|cma|nga` query param on every API request

## Seeding data

Data is shared with the open-archive deployment (same Redis database).
Seed scripts live in `scripts/` — run from the open-archive repo if needed.
