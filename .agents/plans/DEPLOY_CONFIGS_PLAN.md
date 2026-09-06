# Deploy Configs Plan — AWS, Cloudflare, Railway, Vercel

## Context and user outcome

`tephra-server/deploy/` currently contains only prose contracts for AWS, Cloudflare,
and Vercel (no real config files) plus a minimal `railway.json`. Users cannot
one-shot deploy Tephra anywhere except raw Docker/Compose. After this work, each
of the four platforms has a checked-in, documented, schema-correct starting
config grounded in current official docs (researched 2026-09 via Exa + 4
parallel research subagents against docs.aws.amazon.com, developers.cloudflare.com,
docs.railway.com, vercel.com/docs).

## Scope

- `tephra-server/deploy/aws/`: add ECS Fargate + ALB + EFS skeleton files
  (task definition + service) for the stateful single-replica profile; rewrite
  README with concrete steps, secrets handling, and scaled-profile contract.
- `tephra-server/deploy/cloudflare/`: add `wrangler.template.jsonc` (Worker +
  Static Assets + D1/R2 binding skeleton, placeholders only); update README with
  binding names, secrets flow, and limits.
- `tephra-server/deploy/railway/`: harden `railway.json` (explicit
  `numReplicas: 1`); update README (volume is dashboard-managed, `PORT`
  injection, `TEPHRA_PUBLIC_URL` via `RAILWAY_PUBLIC_DOMAIN`, IaC future path).
- `tephra-server/deploy/vercel/`: add `vercel.example.json` (reference scaffold:
  Vite build, SPA rewrites, function routing); update README with blockers,
  env matrix, and limits.

## Non-goals

- No Worker entrypoint (`apps/api/src/worker.ts`), D1/R2 adapters, Vercel
  Function handler, Postgres/S3 adapter work, or migration runner changes.
  Cloudflare/Vercel remain honestly non-deployable until those exist; configs
  are marked template/example.
- No AWS Copilot manifest as primary path (Copilot support ends 2026-06-12 per
  AWS announcement surfaced in research); no `apprunner.yaml` (source-code
  services only, no persistent volumes — wrong fit for `/data` profile).
- No `.railway/railway.ts` IaC file (a service cannot be managed by both CaC
  and IaC; adding both creates a conflict). IaC is documented as the future path.
- No active root `vercel.json` / `wrangler.jsonc` (an active file at the wrong
  root would falsely imply deployability and Vercel Root-Directory constraints
  make `deploy/vercel/` reference-only).
- No secrets, account IDs, ARNs, or real hostnames committed anywhere.

## Invariants and security constraints (from AGENTS.md / Stage 1)

- Stage 1 is a read-only web mirror; no web-to-vault writes introduced.
- Single-container SQLite/filesystem profile stays single-replica everywhere;
  every platform doc states this explicitly.
- Secrets (`TEPHRA_SESSION_SECRET`, `TEPHRA_BOOTSTRAP_TOKEN`, DB/S3
  credentials) only via platform secret stores; never in committed configs.
- `GET /healthz` (liveness) and `GET /readyz` (readiness) preserved as the
  health-check endpoints on all platforms.
- No tokens/passwords/cookies/vault contents in docs or examples.

## Affected files (deploy-only, no app code)

1. `tephra-server/deploy/aws/ecs-taskdef.stateful-efs.json` (new)
2. `tephra-server/deploy/aws/ecs-service.stateful-alb.json` (new)
3. `tephra-server/deploy/aws/README.md` (rewrite)
4. `tephra-server/deploy/cloudflare/wrangler.template.jsonc` (new)
5. `tephra-server/deploy/cloudflare/README.md` (rewrite)
6. `tephra-server/deploy/railway/railway.json` (edit: add `numReplicas`)
7. `tephra-server/deploy/railway/README.md` (rewrite)
8. `tephra-server/deploy/vercel/vercel.example.json` (new)
9. `tephra-server/deploy/vercel/README.md` (rewrite)

## Implementation steps

1. AWS: write task-def skeleton (Fargate, awsvpc, 8080, EFS mount at `/data`
   with transit encryption, Secrets Manager/SSM `secrets` entries, logConfiguration
   awslogs, healthCheck on `/healthz`, all IDs/ARNs as `<PLACEHOLDERS>`).
2. AWS: write service skeleton (`desiredCount: 1`, Fargate, ALB target type ip,
   health check on `/readyz`, grace period).
3. AWS: rewrite README (stateful ECS path, file map, secrets, EFS vs EBS note,
   scaled RDS/S3 contract, why no Copilot/App Runner files).
4. Cloudflare: write `wrangler.template.jsonc` (name, main placeholder,
   compatibility_date, assets SPA + `run_worker_first: ["/api/*"]`, D1 + R2
   skeletons with placeholder IDs, observability).
5. Cloudflare: rewrite README (template usage, binding names, `wrangler secret`
   flow, 100 MiB vs 100 MB limit warning, adapter TODOs).
6. Railway: edit `railway.json` (add `"numReplicas": 1`); rewrite README.
7. Vercel: write `vercel.example.json` (`$schema`, framework vite,
   outputDirectory `../../apps/web/dist` relative note, functions
   `api/index.ts` maxDuration, SPA rewrites, asset caching headers).
8. Vercel: rewrite README (reference-only status, entrypoint + adapter
   blockers, 4.5 MB body limit vs 100 MiB, env matrix).
9. Validate: JSON parse all new/edited JSON, JSONC eyeball check, prettier
   formatting, `npm run check`, `git status` review.

## API/schema changes

None to app code. New files follow these schemas (per official docs):

- ECS task-def/service: `docs.aws.amazon.com/.../task_definition_parameters`
  (requiresCompatibilities, networkMode awsvpc, efsVolumeConfiguration,
  mountPoints, secrets valueFrom).
- Wrangler template: `developers.cloudflare.com/workers/wrangler/configuration`
  (assets.directory/binding/not_found_handling/run_worker_first,
  d1_databases[], r2_buckets[], observability).
- `railway.json`: `railway.com/railway.schema.json` (build.builder DOCKERFILE,
  deploy.healthcheckPath/Timeout/restartPolicy/numReplicas).
- Vercel example: `vercel.com/docs/project-configuration/vercel-json`
  ($schema openapi.vercel.sh, functions, rewrites, headers; memory NOT in file).

## Tests and verification

- No behavior change, so no new unit tests (deploy configs only).
- `node -e "JSON.parse(...)"` over every new/edited JSON file.
- `npx prettier --check` on touched files (write with prettier style).
- `npm run check` (lint + typecheck + build + tests) must pass — deploy-only
  change must not break the build.
- Manual: `git status` shows only the 9 files above.

## Compatibility, deployment, rollback risks

- Risk: config drift as platforms evolve (Railway CaC deprecated 2026-12-01;
  Copilot EOL). Mitigation: READMEs state doc dates and point to live schema URLs.
- Risk: users treating template/example files as working deploys (especially
  Cloudflare/Vercel). Mitigation: filenames (`.template.`, `.example.`),
  placeholder values that fail loudly, and explicit "not yet deployable" banners.
- Risk: ECS skeleton misapplied (wrong region/Account, EFS AZ mismatch).
  Mitigation: placeholders + README checklist, single-AZ/EBS caveats.
- Rollback: delete or revert the 9 files; no app/infra state touched.

## Completion checklist

- [ ] 4 new config files + 1 edited `railway.json`, all schema-correct
- [ ] 4 READMEs rewritten, no secrets, single-replica warning everywhere
- [ ] JSON validation + prettier + `npm run check` green
- [ ] `PROGRESS.md` NOT updated (deploy scaffolding is not a Stage 1 feature)
- [ ] Reported with file paths and honest Cloudflare/Vercel status
