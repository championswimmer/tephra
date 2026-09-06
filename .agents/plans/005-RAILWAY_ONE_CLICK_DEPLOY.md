# 005 — Railway One-Click Deploy with Storage

> **Status:** Proposed implementation plan; no implementation has started
> **Project:** Tephra Stage 1 read-only web mirror
> **Goal:** make the checked-in Railway config out-of-the-box 1-click deployable,
> including all storage requirements
> **Last updated:** 2026-09-06

## 1. Context and user outcome

Deploying Tephra to Railway today is **not** 1-click: the checked-in
`tephra-server/deploy/railway/railway.json` only covers builder, healthcheck,
replicas, and restart policy. The persistent volume mounted at `/data`
(SQLite at `/data/tephra.db` + blobs at `/data/blobs`) is a manual
dashboard step, secrets have no generation story, and `railway.json`
(Config as Code) is **deprecated with a hard cutoff of 2026-12-01**.

After this work, an operator gets a working private Tephra instance by either:

1. creating a Railway Template from the documented composer recipe and
   pressing **Deploy** (true 1-click, volume + generated secrets included), or
2. running `railway config plan` / `railway config apply` with the checked-in
   Infrastructure-as-Code file, which declares the service, volume, mount,
   healthcheck, replica pin, and variables in one place.

Both paths deploy the same single-container SQLite/filesystem image that
Docker Compose uses. No server code changes are required.

## 2. Research findings (Railway docs, September 2026)

- **Volumes cannot be expressed in `railway.json`/`railway.toml`.**
  Config as Code covers only build/deploy sections of one service's settings
  (builder, commands, healthcheck, replicas, restart policy, cron). Volume
  attachment is dashboard/API/CLI-managed. Source:
  `config-as-code/reference`, `volumes` guide.
- **Config as Code is deprecated.** Replacement is Infrastructure as Code
  (`.railway/railway.ts`, TypeScript GA). Existing `railway.json` files keep
  working for legacy services until **2026-12-01**; new services cannot opt
  in. A service **cannot be managed by both systems at once** —
  `railway config plan` refuses until the service is migrated.
  Source: `infrastructure-as-code`, `config-as-code`.
- **IaC expresses exactly what we need:** `service()` with healthcheck,
  replicas, `env` (literals, cross-service refs, `ctx.shared`, `preserve()`
  for secrets), plus `volume(name, { region?, sizeMB? })` attached via
  `volumeMounts: { "/data": data }`. One volume per service; volumes cannot
  be shared across replicas — hence the replica pin of 1.
  Source: `infrastructure-as-code/reference`.
- **Templates are the true 1-click mechanism.** A template captures services,
  variables (with `secret()` generation functions), volumes, and public
  networking; users deploy with one button (`Deploy on Railway` badge).
  The template object itself is created in the dashboard/composer
  (or by converting an existing project) — the repo's job is to make that
  creation mechanical and to document the exact recipe.
  Source: `templates/create`, `templates/publish-and-share`.
- **Non-root images + volumes require `RAILWAY_RUN_UID=0`.** Volumes mount
  root-owned; our image runs as `node`, and the Dockerfile's build-time
  `chown /data` does not survive the runtime volume overlay.
  Source: `volumes` guide ("Permissions").
- **Dockerfile selection without `railway.json`:** Railway auto-uses a
  `Dockerfile` at the source root; ours lives at
  `tephra-server/deploy/docker/Dockerfile`, so the service must set the
  user-provided config variable
  `RAILWAY_DOCKERFILE_PATH=tephra-server/deploy/docker/Dockerfile`
  (documented default: `Dockerfile`). The repo root must stay the build
  context (npm workspace). Source: `variables/reference`,
  `builds/dockerfiles`.
- **Buckets are backup-only.** The Stage 1 runtime is disk-only
  (`apps/api/src/main.ts:19-24` pins `sqlite`/`filesystem`). A Railway Bucket
  may hold periodic snapshot tarballs (plan 005-STORAGE_ENGINES.md) but never
  live blobs. No bucket is provisioned here.

## 3. Scope

- Add `.railway/railway.ts` at the repo root declaring project `tephra`:
  service `tephra` (no `source` — manage settings, stay fork-friendly) +
  volume `tephra-data` mounted at `/data`, with healthcheck, replica pin,
  Dockerfile path, and the full non-secret env contract.
- Delete `tephra-server/deploy/railway/railway.json` in the same change
  (both systems cannot manage one service; the old README already promised a
  one-step migration).
- Secrets (`TEPHRA_SESSION_SECRET`, `TEPHRA_BOOTSTRAP_TOKEN`) use
  `preserve()` — never committed.
- Rewrite `tephra-server/deploy/railway/README.md` for both 1-click paths
  (Template recipe + IaC CLI path), including the exact composer settings,
  `secret()` expressions, and post-deploy bootstrap-token removal.
- Reference the Template/`Deploy on Railway` badge from the server README;
  add the badge markdown only after a published template code exists.
- Exclude `.railway/` from ESLint (and any tsconfig program) so
  `npm run check` stays green without adding the `railway` npm package to
  our workspaces (the IaC file is evaluated by the Railway CLI, not our
  build).

### Explicit non-goals

- Disk-only doctrine (plans 003/004/005-STORAGE_ENGINES): filesystem blobs only, snapshots to buckets.
- Multi-tenant scale-out = one service + one volume per tenant (plan 004 Profile B).
- Multi-replica / multi-region operation (volumes forbid it).
- Zero-downtime redeploys for the volume profile (Railway blocks two live
  mounts; brief downtime is inherent — document, don't fight).
- Automated volume backups (Railway manual/scheduled backups exist;
  operator opt-in, documented as a pointer only).
- Provisioning or mutating a live Railway account from this change
  (CLI in this environment is unauthenticated; `plan`/`apply` and template
  creation are operator steps).
- Claiming 1-click works before a real template deploy passes the smoke test.

## 4. Invariants and security constraints

1. No secrets in git: secrets only via `preserve()` (IaC) and `secret()`
   (template composer). Placeholder-only examples in docs.
2. Exactly one replica while SQLite/filesystem live on one volume.
3. Never bake `PORT`, real domains, or credentials into the IaC file.
   `TEPHRA_PUBLIC_URL` uses the `https://${{RAILWAY_PUBLIC_DOMAIN}}`
   self-reference (already the documented pattern).
4. Blob/SHA-256, revision, read-only, and auth behavior are untouched —
   this change is deployment config + docs only.
5. Do not log tokens or vault contents anywhere new.

## 5. Affected files and ownership

| File | Change |
| ---- | ------ |
| `.railway/railway.ts` (new) | IaC: project, service, volume, mount, env, healthcheck, replicas |
| `tephra-server/deploy/railway/railway.json` | **Delete** (deprecated system; conflicts with IaC) |
| `tephra-server/deploy/railway/README.md` | Rewrite: 1-click template recipe + IaC CLI path + operations |
| `tephra-server/README.md` | Update Railway bullet (IaC + template pointer, no stale `railway.json` claims) |
| `eslint.config.mjs` | Ignore `.railway/` (standalone CLI-evaluated file, `railway/iac` import not installed) |
| `docs/COMPATIBILITY.md` | Touch only if its Railway sentence becomes stale |

No `apps/api`, `packages/*`, Dockerfile, or Compose changes.
No API/schema/migration changes. No new runtime dependencies.

## 6. Ordered implementation steps

### Step 1 — Add `.railway/railway.ts`

```ts
import { defineRailway, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  const data = volume("tephra-data", { sizeMB: 512 });

  const tephra = service("tephra", {
    healthcheck: "/healthz",
    healthcheckTimeout: 120,
    replicas: 1,
    volumeMounts: { "/data": data },
    env: {
      RAILWAY_DOCKERFILE_PATH: "tephra-server/deploy/docker/Dockerfile",
      RAILWAY_RUN_UID: "0",
      TEPHRA_DATABASE_DRIVER: "sqlite",
      TEPHRA_SQLITE_PATH: "/data/tephra.db",
      TEPHRA_BLOB_DRIVER: "filesystem",
      TEPHRA_BLOB_PATH: "/data/blobs",
      TEPHRA_PUBLIC_URL: "https://${{RAILWAY_PUBLIC_DOMAIN}}",
      TEPHRA_SESSION_SECRET: preserve(),
      TEPHRA_BOOTSTRAP_TOKEN: preserve(),
    },
  });

  return project("tephra", { resources: [tephra, data] });
});
```

Notes:

- `preserve()` must be imported from `railway/iac` (sibling of the other
  helpers in the reference's larger example).
- `region` is deliberately omitted from `volume()` so Railway places the
  volume with the service; if `railway config plan` rejects that, pin an
  explicit region and record it here.
- `sizeMB: 512` fits even low-tier volume defaults; personal vaults
  (SQLite + deduped blobs) fit comfortably. Raising later is a
  non-destructive resize.
- No `source`: the file manages settings only, so forks work without edits
  (service source stays whatever repo the Railway project is connected to).
- No `startCommand`/build command: the image `CMD` is already correct;
  Dockerfile path arrives via `RAILWAY_DOCKERFILE_PATH`.

### Step 2 — Delete `railway.json`, exclude `.railway/` from lint

- Delete `tephra-server/deploy/railway/railway.json`.
- Add `.railway/**` (and `**/.railway/**`) to the `ignores` in
  `eslint.config.mjs`. Do **not** add the `railway` npm package to the
  workspace.

### Step 3 — Rewrite `deploy/railway/README.md`

Cover, in order:

1. What 1-click means here (single service + attached volume + generated
   secrets + public domain + `/healthz` gate).
2. **Path A — Template (recommended for end users):** exact composer recipe
   — source repo (root context, Dockerfile path
   `tephra-server/deploy/docker/Dockerfile`), volume attach at `/data`,
   variables with generation expressions
   (`TEPHRA_SESSION_SECRET=${{secret(64,"abcdef0123456789")}}`,
   `TEPHRA_BOOTSTRAP_TOKEN=${{secret(64,"abcdef0123456789")}}`,
   `TEPHRA_PUBLIC_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}`, plus the literal
   storage defaults), healthcheck `/healthz`, one replica, public networking;
   then first-boot flow (open domain → `/setup` → create admin → **remove
   `TEPHRA_BOOTSTRAP_TOKEN`** → create vault + plugin token → sync).
3. **Path B — IaC CLI (for operators/forks):**
   `railway login && railway link` then
   `railway config plan` / `railway config apply`; secrets are set once via
   `railway variable set` and preserved thereafter.
4. Operations: redeploy downtime note, no-scaling rule, backup pointer
   (volume backups tab / schedules), restore-into-new-volume flow, upgrade =
   redeploy + authenticated smoke test.
5. Scaling/future pointer: more tenants = more services, each with its own
   volume (plan 004 Profile B); snapshots (not live blobs) may go to a
   private bucket.

### Step 4 — Update server README + compatibility note

- `tephra-server/README.md` deployment bullet: Railway = Template or IaC,
  Docker image + `/data` volume, one replica. Remove stale `railway.json`
  field-map claims.
- `docs/COMPATIBILITY.md`: only touch if the "Railway uses the Docker
  profile with a mounted volume" sentence becomes inaccurate (it should
  remain accurate).

### Step 5 — Operator verification (requires `railway login`; not done by agent)

1. `railway config plan` — expect: create service `tephra`, create volume
   `tephra-data`, no destructive lines. Resolve any region/sizeMB complaint
   by editing the IaC file and re-planning.
2. `railway config apply` on a scratch project; set the two secrets;
   deploy; wait for `/healthz`.
3. Bootstrap → login → create vault → device token → sync sample vault →
   browse file/note/graph; confirm `/data/tephra.db` + `/data/blobs`
   persist across a redeploy.
4. Convert the verified scratch project into a Template
   (project Settings → Generate Template from Project), publish, capture
   the template code, and only then add the
   `[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template/<CODE>...)`
   badge to the server README.
5. Only after 1–4 pass: mark 1-click supported in `PROGRESS.md`.

## 7. Tests and verification commands

Config-only change; no unit tests apply. Required gates:

```bash
npm run check                                   # lint + typecheck + build + tests
railway config plan                             # operator: expect create-only plan (needs login)
railway config plan --detailed-exit-code        # operator: CI drift gate option
```

`npm run check` must pass before reporting implementation complete.
`railway config plan` output is the schema validation for the IaC file
(there is no local typecheck — `railway/iac` is intentionally not installed).

## 8. Compatibility, deployment, and rollback risks

| Risk | Mitigation / rollback |
| ---- | --------------------- |
| IaC field drift (CLI newer than docs) | `railway config plan` is read-only; fix file, re-plan. No live state touched until `apply`. |
| `volume()` requires explicit `region` | Pin region, record here; region cannot change after creation (would need new volume + data copy). |
| `RAILWAY_DOCKERFILE_PATH` ignored / builder wrong | `plan` shows build config; fallback is dashboard builder override recorded in README; Dockerfile path is already proven via `railway.json` today. |
| `RAILWAY_RUN_UID=0` runs container as root | Railway-prescribed for non-root images with volumes; image keeps `USER node` default for Docker/Compose; note the tradeoff in README. Alternative (root entrypoint that chowns + drops privs) deferred unless review demands it. |
| Existing Railway services managed by `railway.json` | One-step migration is the point; `plan` errors loudly if a service is still on the old system. Rollback = revert commit (volume data itself is untouched by the management-system switch). |
| Decreasing `sizeMB` / detaching volume later | Treated destructive by Railway; never do casually — document. |
| Template shows secrets in composer | Use `secret()` functions; values generate at deploy time, never committed. |
| Claiming 1-click prematurely | `PROGRESS.md` stays silent until the operator smoke (Step 5) passes. |

## 9. Completion checklist

- [ ] `.railway/railway.ts` declares service + 512 MB volume + `/data` mount + full env (secrets via `preserve()`).
- [ ] `tephra-server/deploy/railway/railway.json` deleted.
- [ ] ESLint ignores `.railway/`; no `railway` npm dependency added.
- [ ] `deploy/railway/README.md` documents the exact template recipe and the IaC CLI path with no secrets.
- [ ] Server README + compatibility note no longer reference `railway.json`.
- [ ] `npm run check` passes.
- [ ] Operator runbook steps (plan/apply/smoke/template publish/badge/`PROGRESS.md`) listed as explicit follow-ups, not claimed as done.
