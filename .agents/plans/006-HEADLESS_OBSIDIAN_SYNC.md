# Headless Obsidian Sync Sidecar (disk-only)

> Status: implementation plan
> Depends on: `001-TEPHRA_STAGE1_PLAN.md`, disk layout from `003-MULTI_TENANT_PERSISTENCE.md`
> Profile: single-user self-hosted, Compose/VM targets with a shared `/data`
> Last updated: 2026-09-06

## 1. Context and outcome

A self-hoster with paid **official Obsidian Sync** wants the Tephra mirror
fresh without leaving a laptop online. Because live storage is disk-only,
the answer is trivial: run the official headless CLI on the same machine,
checking out into the **same `/data` volume** the server already uses, and
poll-push each checkout through the **existing plan/upload/commit protocol**.

No new volumes. No file watching. No second service. One sidecar container
runs a loop: `ob sync` (pull) each vault, then push each vault, then sleep.

Research basis (fetched Sep 2026): official `obsidian-headless` CLI
(`obsidianmd/obsidian-headless`: `ob login`, `sync-list-remote`,
`sync-setup`, `sync`, `sync-config`, `sync-status`; Node 22+; `--json`),
official help at `obsidian.md/help/headless`, Docker patterns from
`crosbyh/obsidian-headless-sync-docker` (`*_FILE` secrets, `DEVICE_NAME`,
persistent CLI state). The old Xvfb + full-desktop path is rejected.

## 2. Design

```text
Obsidian Sync cloud (official, paid)
        ^  only `ob` speaks the Sync protocol
        |
tephra-sync sidecar (one container, same /data volume)
  loop every BRIDGE_INTERVAL_SECS (default 60):
    for each mapped vault:
      ob sync --path /data/checkouts/<slug>      # pull-only, one-shot
      bridge push → http://tephra:8080           # plan/upload/commit, no-op if unchanged
        |
Tephra container (unchanged image; /data/tephra.db + /data/blobs)
```

`/data` layout (from plan 003):

```text
/data/checkouts/<slug>/   # `ob` working copy per vault, owned by the sync process
/data/sync-state/         # XDG_CONFIG_HOME: token cache + device identity (persistent)
/data/snapshots/          # backup staging (plan 005)
```

Why poll instead of `--continuous` + watcher: a one-shot `ob sync` that exits
before the push eliminates partial-checkout races, background supervision,
and in-flight detection. Interval sync (default 60 s) is plenty fresh for a
read-only mirror. `SYNC_ONESHOT=true` reuses the same loop for cron/Job use.

Why one container instead of sync+bridge split: both are operator-trusted on
the same VM/disk with the same lifecycle; the bridge mounts the checkout
read-only *by convention* (it never writes there — tested, see §6) and the
split bought nothing but Compose complexity.

## 3. Non-goals

- No server/protocol/schema changes; no new routes, headers, or migrations.
- No web-to-vault writes or merging; Stage 1 read-only invariants stand.
- No hosted/multi-user support (per-user Sync credentials on shared infra).
- No Xvfb/desktop, no unofficial Sync reimplementations, no self-hosted Sync servers.
- No Sync credentials in the Tephra image or process.
- Platform scope: Compose and single-VM targets (GCE PD, EC2/EBS) where
  `/data` is trivially shared. Volume-per-service platforms (Railway, ECS,
  Cloud Run) stay on plugin sync — the sidecar cannot mount their volume
  from a second service.
- No `PROGRESS.md` update until verified.

## 4. Configuration

One vault = one numbered set; checkout dir is the slugified remote name
(lowercase, non-alnum → `-`; collision = startup error). Secrets prefer
`*_FILE` (mode 600 / `/run/secrets/*`); plain values for local trials only;
setting both forms of one credential is a startup error.

| Variable | Required | Notes |
| -------- | -------- | ----- |
| `OBSIDIAN_AUTH_TOKEN_FILE` | yes | account token from one-time `get-token` (`ob login`) |
| `VAULT_NAME_<n>` | yes | exact remote name, case-sensitive (`VAULT_NAME_1`, `_2`, …) |
| `VAULT_PASSWORD_<n>_FILE` | if E2E | vault encryption password, not the account password |
| `TEPHRA_VAULT_ID_<n>` | yes | target Tephra vault UUID for vault `<n>` |
| `TEPHRA_DEVICE_TOKEN_<n>_FILE` | yes | vault-scoped `vault:upload` token for vault `<n>` |
| `TEPHRA_API_URL` | yes | e.g. `http://tephra:8080` |
| `DEVICE_NAME` | no | default `tephra-mirror`; shown in Sync history |
| `SYNC_MODE` | no | `pull` (default) or `mirror`; `bidirectional` refused |
| `BRIDGE_INTERVAL_SECS` | no | default `60` |
| `PUID`/`PGID` | no | checkout owner; rootless Docker → `0:0` |

Validation: entrypoint fails before any sync when the token is missing,
both plain+`_FILE` forms of one credential are set, a slug collides, a
`TEPHRA_VAULT_ID_<n>` has no matching `VAULT_NAME_<n>` (or vice versa), or
`SYNC_MODE` is unknown. Errors list every offending variable; no secrets echoed.

## 5. Files (new; no existing files modified except `sync-vault.mjs` slimming)

- `tephra-server/deploy/docker/Dockerfile.sync` — `node:22-bookworm-slim` +
  pinned `obsidian-headless`, non-root user, `get-token` helper. No Tephra
  source copied in.
- `tephra-server/deploy/docker/sync-entrypoint.sh` — `_FILE` resolution,
  one-time `ob login` (token) + `ob sync-setup` per vault (idempotent),
  `sync-config` (pull/mirror), then the loop.
- `tephra-server/deploy/docker/compose.sync.yml` — overlay: `tephra-sync`
  service sharing `/data` with `tephra`, `restart: unless-stopped`,
  healthcheck via `ob sync-status` + last-push age file.
- `e2e/sync-bridge.mjs` — extracted walk/manifest/plan/upload/commit/verify
  from `e2e/sync-vault.mjs` (`--interval`, `--oneshot`); `sync-vault.mjs`
  becomes a thin wrapper; regression gate is `npm run sync:vault`.
- `e2e/sync-smoke.mjs` — fixture-mode smoke (pre-seeded checkout, no
  credentials in CI).
- `tephra-server/deploy/docker/README-sync.md` — runbook: paid-Sync
  prerequisite, `get-token` → `sync-list-remote` → secrets → up → logs;
  E2E check (desktop Settings → Sync → Encryption password); `$`-escaping
  warning (use `*_FILE`); PUID/PGID table; rotation (`ob logout` + revoke +
  fresh token + wipe `/data/sync-state`); backup (Tephra `/data` as before;
  checkout re-creatable from cloud); rollback (stop overlay; plugin sync resumes).
- `.agents/plans/006-HEADLESS_OBSIDIAN_SYNC.md` (this file).

## 6. Steps

### Phase 0 — Extract bridge (no behavior change)

1. Extract walk (skip dotfiles + `.obsidian`), frontmatter-id-or-`f-<hash>`,
   SHA-256 manifest, plan/upload/commit, rendered+graph verify into
   `e2e/sync-bridge.mjs`.
2. Rewire `sync-vault.mjs` as a wrapper; `npm run sync:vault` passes.
3. Gate: `npm run check` (modulo the pre-existing `tephra-website/.astro`
   lint noise).

### Phase 1 — Sidecar image + loop

1. `Dockerfile.sync` (pinned CLI, non-root, `get-token`).
2. `sync-entrypoint.sh`: validation → login/setup/config → loop
   (`ob sync --path …` then bridge push per vault, sleep, repeat;
   exit after one pass when `SYNC_ONESHOT=true`).
3. Shell arg-building covered without network (mode map `pull→pull`,
   `mirror→mirror`, `bidirectional` rejected).
4. Gate: image builds; `sync-list-remote` works with a throwaway token path.

### Phase 2 — Compose overlay + docs + smoke

1. `compose.sync.yml`; one-time flow documented; `compose config` validates.
2. `README-sync.md` runbook (setup, E2E, rotation, backup, rollback).
3. `e2e/sync-smoke.mjs` fixture-mode smoke.
4. Gate: smoke passes locally; real-Sync standard+E2E vaults verified
   manually once (never in CI).

## 7. Verification

```bash
npm run check
docker build -f tephra-server/deploy/docker/Dockerfile.sync -t tephra-sync:test .
docker compose -f tephra-server/deploy/docker/compose.yml -f tephra-server/deploy/docker/compose.sync.yml config
VAULT_DIR=sample-vault npm run sync:vault
node e2e/sync-smoke.mjs
```

Assertions: commit/recommit-idempotency unchanged; bytes + index/links/graph
identical to plugin push; restart reuses device identity; pull/mirror produce
zero remote mutations; bad config fails fast secret-free; bridge never writes
into a checkout (read-only assertion in smoke).

## 8. Risks

| Risk | Mitigation |
| ---- | ---------- |
| CLI is open beta; flags drift | pinned version; build-time `ob --help` assert; upgrade = rebuild + smoke |
| Secret leak via inspect/logs | `*_FILE`, mode 600, `no-new-privileges`, redaction; placeholders-only docs |
| Duplicate Sync devices | persistent `/data/sync-state`; wipe only for factory reset |
| Partial checkout pushed | one-shot `ob sync` exits before push; content-addressing makes retry safe |
| Bidirectional foot-gun | refused at startup; pull/mirror only |
| Platform without shared `/data` (Railway/ECS/Cloud Run) | out of scope; plugin sync there |

## 9. Checklist

- [ ] Bridge extracted; `sync:vault` regression passes.
- [ ] Sidecar image builds; `get-token`/`sync-list-remote` documented.
- [ ] Overlay validates; healthy on clean host (fixture mode).
- [ ] Pull/mirror verified mutation-free; restart preserves device identity.
- [ ] Real-Sync manual gate (standard + E2E) browsed end-to-end.
- [ ] Runbook covers setup/E2E/rotation/backup/rollback, no secrets.
- [ ] No server/protocol/schema changes; Stage 1 read-only holds.
- [ ] `npm run check` passes.

## 10. References

- `001-TEPHRA_STAGE1_PLAN.md` (read-only mirror, blob/revision invariants).
- `003-MULTI_TENANT_PERSISTENCE.md` (`/data` layout, one volume per tenant).
- `004-DEPLOYMENT_PROFILES.md` (Compose/VM targets; sidecar needs shared `/data`).
- `005-STORAGE_ENGINES.md` (snapshots cover sidecar state too).
- `e2e/sync-vault.mjs`, `tephra-server/apps/api/src/main.ts`.
- Official CLI: `github.com/obsidianmd/obsidian-headless`,
  `obsidian.md/help/headless`, `npmjs.com/package/obsidian-headless`.
- Patterns: `github.com/crosbyh/obsidian-headless-sync-docker`.
