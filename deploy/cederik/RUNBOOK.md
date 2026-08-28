# Runbook: OpenSEO on openseo.cederik.com

Self-hosted OpenSEO for the SEO work on **thenaturalbeautyclub.com**.
Written for a future Claude session on neoremote. Verified against a real teardown/relaunch on 2026-08-28.

## Architecture

- One Hetzner box (context `cederik`), name `cederik-openseo`, type **cax11** (ARM, 4 GB), location nbg1, image ubuntu-24.04, SSH key `neoremote`, login as root.
- Docker Compose stack in `/opt/openseo`: the official `ghcr.io/every-app/open-seo:latest` image plus `caddy:2-alpine` for TLS and basic auth. Files in this directory mirror it.
- App auth mode is `local_noauth`. **Caddy basic auth is the only protection. Never expose port 3001 and never remove the basic_auth block.**
- DNS: A record `openseo` in the Hetzner zone `cederik.com` (zone id 953440), managed with `hcloud zone rrset` under `HCLOUD_CONTEXT=cederik` (export it; never `hcloud context use`).
- MCP endpoint for agents: `https://openseo.cederik.com/mcp`, stateless JSON-RPC, same basic auth.

## Secrets and state (NOT in this public repo)

Everything lives on neoremote in `~/backups/openseo-<date>/` (latest: `openseo-2026-08-28`):

| File | What it is |
|---|---|
| `openseo-data.tar.gz` | The `open_seo_data` docker volume: D1 database with the project, audits, rank tracker baseline, project context, research log |
| `env` | The real `.env` including `DATAFORSEO_API_KEY` |
| `Caddyfile` | With the real bcrypt hash |
| `basic-auth-password.txt` | Plaintext basic auth password (user `cederik`) |
| `compose.yaml` | Same as in this directory |

## Relaunch (about 10 minutes)

```sh
export HCLOUD_CONTEXT=cederik
B=~/backups/openseo-2026-08-28   # pick the newest backup dir

# 1. Server (cloud-init installs docker)
printf '#cloud-config\npackage_update: true\npackages:\n  - docker.io\n  - docker-compose-v2\n' > /tmp/ci.yaml
hcloud server create --name cederik-openseo --type cax11 --image ubuntu-24.04 \
  --location nbg1 --ssh-key neoremote --user-data-from-file /tmp/ci.yaml
IP=$(hcloud server ip cederik-openseo)

# 2. DNS (delete stale record first if one exists)
hcloud zone rrset delete cederik.com openseo A 2>/dev/null || true
hcloud zone rrset create --name openseo --type A --record $IP --ttl 300 cederik.com

# 3. Wait for cloud-init, then swap (REQUIRED: the in-container vite build
#    OOM-kills on 4 GB without it, exit 137 crash loop)
ssh -o StrictHostKeyChecking=accept-new root@$IP "cloud-init status --wait"
ssh root@$IP "fallocate -l 6G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab"

# 4. Restore files and data
ssh root@$IP "mkdir -p /opt/openseo"
scp $B/compose.yaml root@$IP:/opt/openseo/compose.yaml
scp $B/env          root@$IP:/opt/openseo/.env
scp $B/Caddyfile    root@$IP:/opt/openseo/Caddyfile
scp $B/openseo-data.tar.gz root@$IP:/root/
ssh root@$IP "docker volume create openseo_open_seo_data && \
  docker run --rm -v openseo_open_seo_data:/data -v /root:/in alpine tar xzf /in/openseo-data.tar.gz -C /data"

# 5. Firewall and start
ssh root@$IP "ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw --force enable && \
  cd /opt/openseo && docker compose up -d"
```

First start builds the app inside the container: 2 to 5 minutes of 502 behind Caddy is normal. Verify with:

```sh
curl -u cederik:$(cat $B/basic-auth-password.txt) https://openseo.cederik.com/api/health
```

Expect `"status":"ok"` and `"dataforseo":{"status":"ok"}`.

Re-register the MCP in Claude Code:

```sh
claude mcp add --transport http --scope user openseo https://openseo.cederik.com/mcp \
  --header "Authorization: Basic $(printf '%s' "cederik:$(cat $B/basic-auth-password.txt)" | base64 -w0)"
```

## Teardown (reverse order)

```sh
export HCLOUD_CONTEXT=cederik
IP=$(hcloud server ip cederik-openseo)
B=~/backups/openseo-$(date +%F); mkdir -p $B && chmod 700 $B
ssh root@$IP "cd /opt/openseo && docker compose stop open-seo && \
  docker run --rm -v openseo_open_seo_data:/data -v /root:/out alpine tar czf /out/openseo-data.tar.gz -C /data ."
scp root@$IP:/root/openseo-data.tar.gz root@$IP:/opt/openseo/.env root@$IP:/opt/openseo/Caddyfile root@$IP:/opt/openseo/compose.yaml $B/
cp <previous backup>/basic-auth-password.txt $B/   # password does not change
chmod 600 $B/*
hcloud zone rrset delete cederik.com openseo A     # no dangling A record
hcloud server delete cederik-openseo
claude mcp remove --scope user openseo             # dead endpoint otherwise
```

## The project inside OpenSEO

- Project: **The Natural Beauty Club**, id `c61c4953-122b-4e74-8ce1-ff7719753ec3`, domain thenaturalbeautyclub.com, market Belgium (2056) / nl. Belgium only offers nl, fr, de.
- Rank tracker `e878211a-97f4-41ee-b472-f193e923792a`: 15 keywords, mobile, manual mode. Run it weekly (`run_rank_tracker`, needs `maxCostCredits`, one check costs about $0.12). Baseline: 2026-08-28.
- The project context and research log inside OpenSEO are the source of truth for what was bought and fixed. Read them before buying data again.
- Team briefing (Dutch): Claude artifact `9d28ff97-d10c-4a37-af5d-2d1c284e7576`.

## Shopify access (for applying fixes to the shop)

- Store: `cheveux-heureux.myshopify.com` (serves thenaturalbeautyclub.com).
- Use Shopify CLI 4.x: `shopify store auth --store cheveux-heureux.myshopify.com --scopes read_products,write_products,read_online_store_pages,write_online_store_pages`, then `shopify store execute`.
- Tokens are wiped after each work session (`shopify auth logout`). Re-auth per session.
- Headless OAuth on neoremote: shim `xdg-open` to a script that writes `$1` to a file, run `store auth`, send the captured authorize URL to Cederik, have them paste back the failing `http://127.0.0.1:<port>/auth/callback?...` URL, then `curl` that URL locally. The code expires in minutes.
- Page meta descriptions and titles are the metafields `global.description_tag` and `global.title_tag` (`metafieldsSet`, max 25 per call). Collection SEO goes through `collectionUpdate` with `input: {id, seo}`. The homepage title and description live in Online Store > Preferences and have **no API**: Cederik pastes those by hand.

## Costs

- Server: cax11, about EUR 3.79 per month. Teardown when idle; relaunch takes 10 minutes with this runbook.
- DataForSEO: pay per call. Typical: keyword research about $0.05 to $0.10 per seed, rank check $0.12 per 15-keyword run, domain overview and ranked keywords a few cents each. Log every purchase in the OpenSEO research log.
