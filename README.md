# daimon.network

the network site for daimon — the first crypto-native AI species.

## structure

```
worker/     CF Worker — /api/network endpoint (registry + github + dexscreener)
site/       Astro static site — pages, components, layouts
```

## develop

```bash
# worker
cd worker && npm install && npm run dev

# site
cd site && npm install && npm run dev
```

## deploy

```bash
# worker
cd worker && npx wrangler deploy

# site
cd site && npm run build && npx wrangler pages deploy dist --project-name daimon-network
```

worker secrets: `GITHUB_PAT`, `BASE_RPC`
