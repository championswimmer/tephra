# Railway deployment

Railway runs the same Docker image as the single-container deployment. The
checked-in Infrastructure-as-Code file `.railway/railway.ts` (repo root)
declares the whole project in one place: one `tephra` service, one
`tephra-data` volume mounted at `/data`, the repo Dockerfile, the
`/healthz` healthcheck, **one replica** (required for the
SQLite/filesystem profile — volumes cannot be shared across replicas), and
every non-secret variable. Secrets are never in git; they use `preserve()`
so Railway keeps the values already set on the service.

Field names follow the Railway Infrastructure-as-Code reference
(researched September 2026). Config as Code (`railway.json`) is deprecated
and cannot express volumes, so this repo no longer ships it — a service
cannot be managed by both systems at once.

## One-command deploy (IaC CLI path)

Prerequisite: the Railway CLI installed and `railway login` completed.

From the repository root:

```bash
railway link                         # pick (or create) the Railway project
railway config plan                  # read-only preview; expect create-only lines
railway config apply                 # confirm, then the service + volume are created
```

Then set the two secrets exactly once (generate independent values locally):

```bash
export TEPHRA_SESSION_SECRET="$(openssl rand -hex 32)"
export TEPHRA_BOOTSTRAP_TOKEN="$(openssl rand -hex 32)"
printf '%s' "$TEPHRA_SESSION_SECRET" | railway variable set TEPHRA_SESSION_SECRET --stdin --service tephra
printf '%s' "$TEPHRA_BOOTSTRAP_TOKEN" | railway variable set TEPHRA_BOOTSTRAP_TOKEN --stdin --service tephra
```

`preserve()` keeps these values on later `apply` runs. The app binds
`0.0.0.0:$PORT` using the injected `PORT` — do not set `PORT` manually.

## First boot

1. Deploy and wait for the `/healthz` healthcheck to go green.
2. Open the service's public domain. When no users exist, Tephra shows the
   bootstrap page.
3. Enter the bootstrap token and create the first (and only) account.
4. Confirm login, then **remove `TEPHRA_BOOTSTRAP_TOKEN`** from the service
   variables (it is one-time; leaving it set re-arms first-setup while no
   user exists, and it must never become a login credential).
5. Create a vault and one vault-scoped plugin token; complete a real plugin
   sync and browser read.

Expected storage layout on the volume: SQLite at `/data/tephra.db`, blobs
under `/data/blobs` (image defaults; also pinned explicitly in the IaC
file).

## One-click template path (for end users)

For a Deploy-button flow, convert a verified project into a template:
project Settings → Generate Template from Project. In the composer, keep the
repo source with the Dockerfile path
`tephra-server/deploy/docker/Dockerfile`, the `/data` volume attachment,
public networking, the `/healthz` healthcheck, one replica, and the same
variables — but generate the secrets at deploy time with:

```text
TEPHRA_SESSION_SECRET=${{secret(64,"abcdef0123456789")}}
TEPHRA_BOOTSTRAP_TOKEN=${{secret(64,"abcdef0123456789")}}
TEPHRA_PUBLIC_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}
```

Publishing that template yields the `Deploy on Railway` badge for the
server README. The badge is added only after a published template code
exists and a clean template deploy passes the first-boot smoke above.

## Operations

- Expect brief downtime on redeploys of volume-backed services (Railway
  blocks two live mounts on one volume to prevent corruption), even with a
  healthcheck.
- Never scale above one replica or attach a second service to this volume
  while SQLite/filesystem storage is in use.
- Back up from the volume Backups tab (manual or scheduled) or as described
  in the server README (stop-consistent archive or SQLite online backup
  coordinated with a blob copy). Protect backups as private data.
- Upgrade: redeploy the new image, then run an authenticated
  browse-and-sync smoke test (healthcheck green is not sufficient).

## Scaling and future paths

More tenants means more services, each with its own volume (never share one
volume across services or replicas while SQLite/filesystem storage is in
use). A private Railway bucket may hold periodic snapshot tarballs (backup
only — see plan `005-STORAGE_ENGINES.md`); it never serves live blobs.
