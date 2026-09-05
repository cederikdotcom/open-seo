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

## Google Search Console + GA4 (planned at the 2026-09 relaunch)

Free, read-only, no DataForSEO credits. GSC gives real clicks, impressions, per-query CTR and URL inspection; GA4 gives conversions and revenue per landing page. Full docs: `docs/SELF_HOSTING_GOOGLE_SEARCH_CONSOLE.md` and `docs/SELF_HOSTING_GOOGLE_ANALYTICS.md` in this repo. Long term, NimsForest issue #237 (iamnim/pantheon Google token broker) replaces this per-app OAuth; until it lands, the built-in connect below is the way.

Split of work:

**Cederik, one time, in a browser (about 15 minutes):**
1. In [Google Cloud Console](https://console.cloud.google.com/): create a project, enable the **Search Console API**, **Analytics Admin API**, and **Analytics Data API**.
2. OAuth consent screen: External, Testing mode is fine; add the connecting Google account as a **test user**.
3. Create an OAuth client, type Web application, with BOTH redirect URIs, exact match, no trailing slash:
   - `https://openseo.cederik.com/api/gsc/oauth/callback`
   - `https://openseo.cederik.com/api/ga4/oauth/callback`
4. Hand the Client ID and Client secret to the Claude session.
5. Prerequisite on the Google side: thenaturalbeautyclub.com must be a **verified GSC property**, and the GA4 property (Shopify's Google & YouTube channel usually created one) must be accessible to that same Google account.

**Claude session:**
1. Put `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` into `/opt/openseo/.env`. `BETTER_AUTH_SECRET` is already in the backup env (generated 2026-08-29). **Never rotate it: it encrypts the stored Google grants; changing it kills the connections.**
2. `cd /opt/openseo && docker compose up -d --force-recreate open-seo`.
3. Send Cederik to **Integrations → Connect with Google** in the app (any browser works: the redirect URI is the public domain, no localhost trick needed). Connect GSC and GA4 separately, bind both to the project.
4. Verify: `/api/health` shows gsc ok, then MCP tools `get_search_console_performance`, `inspect_urls` (check indexing of the fixed pages), and the `get_google_analytics_*` reports work.

## Costs

- Server: cax11, about EUR 3.79 per month. Teardown when idle; relaunch takes 10 minutes with this runbook.
- DataForSEO: pay per call. Typical: keyword research about $0.05 to $0.10 per seed, rank check $0.12 per 15-keyword run, domain overview and ranked keywords a few cents each. Log every purchase in the OpenSEO research log.

## NimsForest broker wiring (2026-09-05, #264 / #251)

The restored installation is based on upstream v0.1.7. Keep that deployed baseline;
never replace it with the fork's older pre-relaunch checkout. The broker patch
changes the existing GSC/GA4 clients' token source, without adding ingestion adapters.

Set only these server-side variables in the protected `/opt/openseo/.env`:

- `IAMNIM_GOOGLE_BROKER_URL=https://iamnim.com`
- `IAMNIM_ORG_SLUG=thenaturalbeautyclub`
- `IAMNIM_PAT=<human-created, Club-scoped GSC/GA4-vending PAT>`

This deployment-level broker is allowed only in the existing `local_noauth` mode,
behind Caddy authentication, for `local-admin`. Hosted or multi-user mode refuses
it. The organization is fixed in configuration, never derived from a project or
request. Do not set `GOOGLE_CLIENT_ID` or `GOOGLE_CLIENT_SECRET` for this Club service.
Keep `BETTER_AUTH_SECRET` from the backup unchanged.

The existing connect buttons open the organization's iamnim grant page in broker
mode. The operator supplies a scoped PAT through the protected environment file;
missing authority never falls back to OpenSEO OAuth. `iamnim:<org>` identifies the
broker connection source, not an invented Google account or consent row. Property
selection still calls the existing Google clients to verify access before storing
the project mapping. Missing grants, properties or data remain unavailable. No
userinfo/email scope is requested just to decorate the property picker.

Disconnecting a project removes its property mapping; it does not revoke another
person's organization grant. Revoke the named grant or PAT in iamnim when intended.
Tokens are fetched at runtime, redirects refused, short expiry validated, and broker
error bodies/credentials suppressed. Existing DataForSEO credentials and restored
research history remain intact.

Validation before activation: broker unit tests plus existing GSC/GA4/OAuth tests,
TypeScript and production build; anonymous Caddy401 and authenticated health200;
then actual property selection/read using a consenting account. Configuration or
an optional health check saying "not configured" does not prove metric readiness.
