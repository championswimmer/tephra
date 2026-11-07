// Railway Infrastructure as Code for the Tephra single-user profile.
//
// Deploy with: railway config plan && railway config apply
// (run `railway login` and `railway init` or `railway link` first).
//
// This declares one service plus its persistent volume in a single file.
// Secrets are intentionally NOT stored here: TEPHRA_BOOTSTRAP_TOKEN (and the
// legacy TEPHRA_SESSION_SECRET, no longer read by the Go server) use
// preserve(), so Railway keeps the values already set on the service. Set the
// bootstrap token once with `railway variable set`.
import { defineRailway, github, preserve, project, service, volume } from 'railway/iac';

export default defineRailway((ctx) => {
  // SQLite database + filesystem blobs live here. 1000 MB (resized from 512 MB online) fits personal vaults
  // comfortably; growing later is a non-destructive resize.
  // Pinned to Europe West (Amsterdam): europe-west4-drams3a
  const data = volume('tephra-data-eu', { sizeMB: 1000, region: 'europe-west4-drams3a' });

  const tephra = service('tephra', {
    source: github('championswimmer/tephra', { branch: 'main' }),
    healthcheck: '/healthz',
    healthcheckTimeout: 120,
    // Mandatory while SQLite/filesystem blobs live on one volume: volumes
    // cannot be shared across replicas. Single replica pinned to Europe West.
    replicas: { 'europe-west4-drams3a': 1 },
    volumeMounts: {
      '/data': data,
    },
    env: {
      // The repo root stays the Docker build context (npm workspace); the
      // Dockerfile lives in a subdirectory. This is the Go server image
      // (static binary, ~14 MiB idle RSS).
      RAILWAY_DOCKERFILE_PATH: 'tephra-server/deploy/docker/Dockerfile.go',
      // Build arg read by Dockerfile.go: include Node + npm in the runtime image
      // so the official Obsidian headless sync client can run (spawned only
      // when a vault uses Obsidian Sync; no idle cost otherwise).
      WITH_OBSIDIAN_SYNC: 'true',
      // The image runs as an unprivileged user (UID 1000 `node` with
      // WITH_OBSIDIAN_SYNC=true) but volumes mount root-owned; Railway
      // prescribes UID 0 for this combination.
      RAILWAY_RUN_UID: '0',
      TEPHRA_DATABASE_DRIVER: 'sqlite',
      TEPHRA_SQLITE_PATH: '/data/tephra.db',
      TEPHRA_BLOB_DRIVER: 'filesystem',
      TEPHRA_BLOB_PATH: '/data/blobs',
      TEPHRA_WEB_ROOT: '/app/web',
      // Resolves to the service's public domain at runtime (for example
      // https://tephra.up.railway.app). Do not set PORT; the app already
      // binds the injected $PORT.
      TEPHRA_PUBLIC_URL: 'https://${{RAILWAY_PUBLIC_DOMAIN}}',
      // Legacy: unused by the Go server; preserved so apply never deletes it.
      TEPHRA_SESSION_SECRET: preserve(),
      TEPHRA_BOOTSTRAP_TOKEN: preserve(),
    },
  });

  return project(ctx.projectName ?? 'my-tephra', {
    resources: [tephra, data],
  });
});
