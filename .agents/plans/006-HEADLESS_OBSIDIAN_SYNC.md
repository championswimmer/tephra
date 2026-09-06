# Headless Obsidian Sync Sidecar (self-hosted)

> Status: research + implementation plan
> Depends on: `001-TEPHRA_STAGE1_PLAN.md`, `004-DEPLOYMENT_PROFILES.md`
> Profile: single-user self-hosted only
> Last updated: 2026-09-06

## 1. Context and user outcome

A self-hosting Tephra user already pays for **official Obsidian Sync** and wants
the Tephra web mirror to stay fresh without leaving a laptop/phone online and
without installing the Tephra plugin on every device.

Outcome: on the same VM/host that runs Tephra, an **opt-in sidecar** keeps a
local vault checkout in sync via **official Obsidian Sync**, and a small
**bridge loop** pushes that checkout into Tephra through the **existing
Stage 1 plan/upload/commit protocol**. The Tephra server itself does not speak
the Sync protocol and does not change.

This plan is research-backed. Key finding: Obsidian now ships an official
headless CLI (`obsidian-headless`, open beta, Feb 2026) that supersedes the old
Xvfb + full-desktop hacks. The sidecar must use the official CLI, not a
reverse-engineered Sync server.

Sources consulted (fetched Sep 2026):

- Official CLI repo + command reference: `obsidianmd/obsidian-headless`
  (`ob login`, `sync-list-remote`, `sync-setup`, `sync`, `sync --continuous`,
  `sync-config`, `sync-status`, `sync-unlink`; Node 22+; `--json` mode).
- Official help: `obsidian.md/help/headless`, `obsidian.md/help/sync/headless`.
- npm: `obsidian-headless` 0.0.8.
- Community Docker wrappers (patterns only, not dependencies):
  `crosbyh/obsidian-headless-sync-docker` (official-CLI based, `OBSIDI­AN_AUTH_TOKEN`,
  `VAULT_NAME`, `VAULT_PASSWORD_FILE`, `DEVICE_NAME`, `SYNC_MODE`,
  `SYNC_ONESHOT`, multi-vault, `*_FILE` secrets, `sync-status` healthcheck,
  s6/read-only-rootfs hardening) and `belphemur/obsidian-headless` docs
  (Compose, PUID/PGID, `pull`/`mirror` modes, periodic rescan).
- Legacy Xvfb path: `rolle.design` headless guide (Ubuntu 22.04, Xvfb +
  Openbox + x11vnc + systemd, Oct 2024, self-notes "no longer necessary
  because Obsidian Headless was released Feb 2026"); `rup12.net` headless
  guide (updated Mar 2026: "fully fledged headless client … disregard"
  the X11 section); Obsidian forum Xvfb/GPU-crash threads
  (`--disable-gpu --disable-software-rasterizer`, `xvfb-run`).

## 2. Scope

- Add an opt-in, documented Compose sidecar for **Profile A (single-user
  self-hosted)** that:
  1. runs official `ob sync --continuous` (or one-shot on a timer),
  2. runs a Tephra bridge loop that pushes the local checkout into Tephra
     via the existing plugin protocol,
  3. persists Sync device identity across restarts.
- Support one Obsidian account and 1..N vaults mapped to 1..N Tephra vaults.
- Support standard and end-to-end-encrypted vaults (password via secret file).
- Document one-time login/token capture, vault linking, sync modes,
  healthchecks, backups, rotation, and rollback.
- Add a bounded smoke script proving checkout → Tephra commit → browser read.

### Explicit non-goals

- No change to the Tephra sync protocol, schema, auth, or reader API.
- No web-to-vault writes, merging, or Stage 2 behavior. The bridge never
  writes into the vault checkout; Stage 1 read-only invariants stand.
- No hosted/multi-user support: per-user Obsidian credentials on a shared
  server are out of scope (privacy, secret sprawl, ToS risk).
- No Xvfb/full-desktop path as a supported option (documented only as
  rejected legacy).
- No unofficial Sync protocol reimplementation or self-hosted Sync server
  (e.g. `obi-sync-docs`, LiveSync/CouchDB, Relay, git/Syncthing bridges).
  Those replace official Sync; this plan piggybacks on it.
- No baking Sync credentials into the Tephra API image or process.
- No `latest`-only deployment, no secrets committed to the repo.
- No `PROGRESS.md` update until verified per repo rules.

## 3. Invariants and security constraints

From `AGENTS.md` plus this plan:

- Original file bytes canonical; blobs immutable + SHA-256 verified;
  successful commits revisioned (unchanged — bridge reuses the same path
  as `e2e/sync-vault.mjs` and the plugin).
- Shared packages stay browser-safe; Node-only code lives in adapters and
  the bridge entrypoint.
- Never log tokens, passwords, cookies, vault contents, DB URLs, or
  object-store credentials. Redact bridge/CLI output on failure.
- Secrets only via environment files with mode 600 or Docker/Podman
  secrets mounted at `/run/secrets/*` and referenced by `*_FILE` vars.
  Setting both plain and `_FILE` variants of the same credential is a
  startup error (fail closed, list all offending vars).
- Sync auth token and vault E2E password are independent credentials;
  never confuse account password with vault encryption password.
- Sidecar runs unprivileged (fixed PUID/PGID mapping documented), with
  `no-new-privileges`, read-only root filesystem where supported, and a
  persistent config volume so restarts reuse the same Sync device identity
  instead of registering a new device each boot.
- Recommended `SYNC_MODE` for Stage 1 is `pull-only` (or `mirror-remote`):
  download remote changes, ignore/revert local changes. `bidirectional`
  is allowed only when the operator understands the checkout is
  Tephra-bridge-read-only and no other writer touches it.
- The bridge mounts the checkout **read-only**; the Sync process owns
  writes. Any bridge write attempt into the checkout is a bug.
- Requires the operator's own paid Obsidian Sync subscription; the token
  persists until explicit logout/revocation. Document revocation.

## 4. Architecture

```text
Obsidian Sync cloud (official, paid)
        ^  (Sync protocol — only `ob` speaks it)
        |
obsidian-sync container (official obsidian-headless CLI)
  - `ob sync --continuous` (or one-shot via timer)
  - volumes: vault-data:/vault:rw, sync-state:/data/config
        |
vault-data volume (plain Markdown files, `.obsidian` included)
        |
tephra-bridge container (Node 22, read-only mount of vault-data)
  - walk → manifest → plan → upload missing blobs → commit → verify
  - auth: Tephra vault-scoped device token (existing `vault:upload` scope)
        |  (existing Stage 1 HTTP API — no new routes)
        v
Tephra container (unchanged image: API + web, SQLite + blobs in /data)
```

Why two sidecar containers instead of one: the Sync CLI owns the checkout
read-write; the bridge only needs read + HTTP. Sharing `vault-data`
between two minimal containers preserves least privilege and lets either
be restarted/upgraded independently. A single-container s6 variant is an
acceptable implementation detail, but the plan's default is two services.

Why not bake into the Tephra image: mixes concerns, bloats the audited
server image with Sync credentials, breaks the one-process-per-container
and unprivileged-server posture in plans 001/004.

## 5. Affected files/packages and ownership

New files (non-overlapping with active plans 002–005):

- `tephra-server/deploy/docker/compose.sync-sidecar.yml` (new): extends
  `compose.yml` with `obsidian-sync` + `tephra-bridge` services, `vault-data`
  + `sync-state` volumes, secret mappings, healthchecks. Does not modify
  `compose.yml` or `Dockerfile`.
- `tephra-server/deploy/docker/Dockerfile.sync-sidecar` (new): minimal
  `node:22-bookworm-slim` + `npm i -g obsidian-headless@<pinned>` +
  `get-token` helper; runs as non-root; no Tephra source copied in.
- `tephra-server/deploy/docker/obsidian-sync-entrypoint.sh` (new):
  idempotent `sync-setup` then `sync --continuous` (or one-shot when
  `SYNC_ONESHOT=true`); applies `sync-config` (mode, conflict strategy,
  file-types, excluded-folders); validates `*_FILE` vs plain conflicts.
- `e2e/sync-bridge.mjs` (new, extracted from `e2e/sync-vault.mjs`):
  reusable walk/manifest/plan/upload/commit/verify used by both the demo
  script and the bridge loop. `sync-vault.mjs` becomes a thin wrapper.
- `e2e/sync-sidecar-smoke.mjs` (new): bounded Compose smoke (see §8).
- `tephra-server/deploy/docker/README-sync-sidecar.md` (new): operator
  runbook (setup, E2E, modes, rotation, backup, rollback).
- `.env.example`, `tephra-server/.env.example`: additive `*_FILE`-first
  Sync/bridge variables (placeholders only).
- `.agents/plans/006-HEADLESS_OBSIDIAN_SYNC.md` (this file).

No changes to: `apps/api/*`, `packages/*`, migrations, plugin source,
`Dockerfile`, `compose.yml`, Railway/AWS/Vercel/Cloudflare targets.

## 6. Configuration

Prefer the community-established names so operators can reuse prior art.
All secrets prefer `*_FILE`; plain values are for local trials only.

| Variable | Service | Required | Notes |
| -------- | ------- | -------- | ----- |
| `OBSIDIAN_AUTH_TOKEN_FILE` | obsidian-sync | yes | `/run/secrets/obsidian_token`; or `OBSIDIAN_AUTH_TOKEN` locally |
| `VAULT_NAME` / `VAULT_NAME_<n>` | obsidian-sync | yes (first run) | exact remote name, case-sensitive; numbered form for multi-vault → subdirs |
| `VAULT_PASSWORD_FILE` / `VAULT_PASSWORD_<n>_FILE` | obsidian-sync | if E2E | vault encryption password, not account password; `$` safe via files |
| `DEVICE_NAME` | obsidian-sync | no | default `tephra-mirror`; shown in Sync history |
| `SYNC_MODE` | obsidian-sync | no | `pull-only` (default here) \| `mirror-remote` \| `bidirectional` |
| `CONFLICT_STRATEGY` | obsidian-sync | no | `merge` default |
| `EXCLUDED_FOLDERS` | obsidian-sync | no | comma-separated |
| `FILE_TYPES` | obsidian-sync | no | e.g. `image,audio,video,pdf,unsupported` |
| `SYNC_ONESHOT` | obsidian-sync | no | `true` → sync once + exit (cron/K8s Job mode) |
| `PUID` / `PGID` | obsidian-sync | no | match checkout owner; rootless Docker → `0:0` |
| `TEPHRA_API_URL` | bridge | yes | e.g. `http://tephra:8080` (Compose DNS) |
| `TEPHRA_VAULT_ID` | bridge | yes | target Tephra vault UUID |
| `TEPHRA_DEVICE_TOKEN_FILE` | bridge | yes | vault-scoped `vault:upload` token |
| `BRIDGE_INTERVAL_SECS` | bridge | no | default `60`; debounce + full-manifest push |
| `VAULT_HOST_PATH` | host | yes | persistent checkout dir or `vault-data` volume |

Validation: entrypoint fails before Sync when token/vault missing, both
plain+`_FILE` set, or `SYNC_MODE` unknown. Bridge fails before polling
when API/vault/token missing or checkout unreadable. Errors list every
offending variable; no secrets echoed.

## 7. Ordered implementation steps

### Phase 0 — Extract reusable bridge (no behavior change)

1. Extract walk (skip dotfiles + `.obsidian`), frontmatter-id-or-`f-<hash>`,
   SHA-256 manifest, plan/upload/commit, rendered+graph verify from
   `e2e/sync-vault.mjs` into `e2e/sync-bridge.mjs` with `--interval`,
   `--oneshot`, `--read-only-checkout` flags.
2. Rewire `sync-vault.mjs` to import it; `npm run sync:vault` still passes.
3. Gate: `npm run check`.

### Phase 1 — Sidecar image + entrypoint

1. Add `Dockerfile.sync-sidecar` (pinned `obsidian-headless` version,
   non-root user, `get-token` helper wrapping `ob login` → prints
   `OBSIDIAN_AUTH_TOKEN` once).
2. Add `obsidian-sync-entrypoint.sh`: `_FILE` resolution + conflict check,
   one-time `ob sync-setup --vault … --device-name …` (idempotent),
   `ob sync-config` application, then `exec ob sync --continuous`
   (or single `ob sync` when `SYNC_ONESHOT=true`).
3. Unit-test the shell arg-building (mode map: `pull-only→pull`,
   `mirror-remote→mirror`) without network.
4. Gate: image builds; `sync-list-remote` works with a throwaway token
   path in CI dry-run (no real credentials).

### Phase 2 — Compose + bridge wiring

1. Add `compose.sync-sidecar.yml`: `obsidian-sync` (rw on `vault-data`,
   `sync-state:/data/config` for CLI state/device identity) + `tephra-bridge`
   (ro on `vault-data`, bridge env, `restart: unless-stopped`, healthcheck
   via `ob sync-status` in sync container + bridge last-commit age).
2. Document one-time flow: `get-token` → `ob sync-list-remote` → fill
   `.env.sync` / secrets → `docker compose -f compose.yml -f
   compose.sync-sidecar.yml up -d` → logs.
3. Gate: `docker compose -f … config` validates; clean host reaches
   `healthy`.

### Phase 3 — Docs + smoke

1. Write `README-sync-sidecar.md`: paid-Sync prerequisite, E2E check
   (desktop Settings → Sync → Encryption password), `$`-escaping warning
   for `.env` vs `*_FILE`, PUID/PGID table, multi-vault mapping,
   rotation (`ob logout` + revoke + fresh `get-token` + recreate
   `sync-state`), backup (Tephra `/data` as before; `sync-state` persistent;
   `vault-data` re-creatable from cloud), rollback (stop sidecar stack;
   plugin sync resumes unchanged).
2. Add `e2e/sync-sidecar-smoke.mjs`: push fixture via `ob` one-shot (or
   pre-seeded checkout in CI without credentials), assert bridge commit
   revision increments, rendered notes + graph match `sync-vault` asserts,
   restart preserves device identity, `mirror-remote` leaves no remote diff.
3. Gate: smoke passes against local Compose with a fixture checkout (CI
   uses fixture mode; real-Sync path is a documented manual gate).

## 8. Tests and verification commands

```bash
npm run check
docker build -f tephra-server/deploy/docker/Dockerfile.sync-sidecar -t tephra-sync-sidecar:test .
docker compose -f tephra-server/deploy/docker/compose.yml -f tephra-server/deploy/docker/compose.sync-sidecar.yml config
VAULT_DIR=sample-vault npm run sync:vault   # regression: extraction changed nothing
node e2e/sync-sidecar-smoke.mjs             # fixture-mode smoke
```

Required assertions:

- bootstrap/login/plan/upload/commit/recommit-idempotency unchanged.
- Rendered Markdown + attachment bytes identical to checkout source.
- Index/links/graph identical to plugin-pushed result for same vault.
- Restart of `obsidian-sync` reuses device identity (no duplicate device
  in `sync-list-local` / Sync history beyond the first).
- `pull-only`/`mirror-remote` produce zero remote mutations from bridge
  activity (bridge writes nothing locally; Sync uploads nothing).
- Missing token/vault, plain+`_FILE` conflict, bad `SYNC_MODE` fail fast
  with secret-free errors.
- `npm run check` passes; no new `lint`/`typecheck` regressions.

Manual gate (real Sync account, never in CI): one E2E vault + one
standard vault each complete setup → continuous sync → bridge commit →
browser file/render/attachment/link/graph read → rotation drill.

## 9. API/schema/migration changes

None. The bridge is an HTTP client of the existing Stage 1 routes
(`sync/plan`, `blobs/:hash`, `sync/commit`, `files`, `rendered`, `graph`)
with an existing vault-scoped device token. No new endpoints, headers,
protocol versions, or migrations.

## 10. Compatibility, deployment, and rollback risks

| Risk | Mitigation |
| ---- | ---------- |
| `obsidian-headless` is open beta; CLI flags drift | pin image tag to CLI version; entrypoint asserts `ob --help` surface at build; document upgrade = rebuild + fixture smoke |
| Token/E2E password leak via `docker inspect`/logs | `*_FILE` secrets, mode 600, read-only rootfs, `no-new-privileges`, redaction tests; placeholders-only examples |
| Duplicate Sync devices on every restart | persistent `sync-state` volume (`XDG_CONFIG_HOME`); never delete it except for factory-reset; smoke asserts stable identity |
| Bridge pushes partial checkout mid-Sync | interval full-manifest push + Sync one-shot completion gate; skip while `sync-status` reports in-flight; content-addressing makes retries safe |
| Bidirectional foot-gun (bridge dir edited → upload to Sync cloud) | default `pull-only`; bridge mount is read-only; docs warn; smoke asserts no remote diff in pull/mirror modes |
| Large vault initial sync RAM/time | one-shot first sync + bounded smoke; `EXCLUDED_FOLDERS`/`FILE_TYPES` knobs; same 100 MiB blob cap applies |
| Xvfb/desktop fallback temptation | explicitly rejected; official CLI needs no display, no `--no-sandbox`, no GPU flags |
| Multi-user credential sprawl | sidecar is Profile A only; hosted profile keeps plugin-token model from plans 002–004 |
| Operator deletes `vault-data` expecting data loss | documented re-creatable-from-cloud; Tephra `/data` remains the backed-up mirror dataset |
| Rollback | `docker compose -f compose.yml -f compose.sync-sidecar.yml down` (or `SYNC_ONESHOT` off); Tephra image/data untouched; plugin sync resumes |

## 11. Completion checklist

- [ ] `sync-bridge.mjs` extracted; `sync:vault` regression passes.
- [ ] Pinned sidecar image builds and `get-token`/`sync-list-remote` flow documented.
- [ ] `compose.sync-sidecar.yml` validates and reaches healthy on a clean host (fixture mode).
- [ ] Pull-only default verified to produce no remote mutations.
- [ ] Restart preserves Sync device identity.
- [ ] Real-Sync manual gate (standard + E2E vault) browsed end-to-end.
- [ ] Runbook covers setup, E2E, modes, rotation, backup, rollback with no secrets.
- [ ] No server/protocol/schema changes; Stage 1 read-only invariants hold.
- [ ] `npm run check` passes.

## 12. References

- `001-TEPHRA_STAGE1_PLAN.md` (read-only mirror, blob/revision invariants).
- `004-DEPLOYMENT_PROFILES.md` (Profile A single-container defaults; sidecar is additive).
- `e2e/sync-vault.mjs`, `tephra-server/apps/api/src/main.ts` (protocol + runtime composition).
- Official CLI: `github.com/obsidianmd/obsidian-headless`, `obsidian.md/help/headless`,
  `obsidian.md/help/sync/headless`, `npmjs.com/package/obsidian-headless`.
- Community patterns: `github.com/crosbyh/obsidian-headless-sync-docker`,
  `belphemur.github.io/obsidian-headless/installation/docker.html`.
- Legacy Xvfb background: `rolle.design/setting-up-a-headless-obsidian-instance-for-syncing`,
  `rup12.net/posts/running-obsidian-headless`, Obsidian forum headless/Xvfb threads.
