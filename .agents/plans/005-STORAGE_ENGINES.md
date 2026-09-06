# Tephra Blob Storage Engines

> Status: implementation plan
> Depends on: `001-TEPHRA_STAGE1_PLAN.md`; blob namespacing from `003-MULTI_TENANT_PERSISTENCE.md`
> Consumed by: `004-DEPLOYMENT_PROFILES.md` for profile-specific storage configuration
> Last updated: 2026-09-06

## Outcome

Tephra will support two production blob storage engines behind one `BlobStore` contract, selected
by configuration and verified by one shared conformance suite:

| Engine       | Driver value | Backing storage                                                      | Replicas                         |
| ------------ | ------------ | -------------------------------------------------------------------- | -------------------------------- |
| Mounted disk | `filesystem` | Local disk, EBS, EFS/NFS, Railway volume, Fly volume, NAS bind mount | One writer per volume            |
| Object store | `s3`         | AWS S3, Cloudflare R2, MinIO, Railway bucket, Backblaze B2, Ceph/RGW | Any number of stateless replicas |

"Block storage" in the request maps to two different things and this plan keeps them separate:
block devices (EBS) and network filesystems (EFS) are consumed through the **mounted-disk**
engine, while S3 and S3-compatible services are object stores consumed through the **object**
engine. Both remain first-class; neither is deprecated.

Canonical vault bytes, immutability, SHA-256 verification, revisioning, and tenant namespacing are
identical on both engines. The engine choice changes durability, operations, and how many API
replicas may run — nothing about the sync protocol or the reader API.

## Current state

- `@tephra/blob-store-core` defines `has`/`put`/`get`/`delete` with streaming reads and writes.
- `@tephra/blob-store-filesystem` implements a two-level sharded layout with temp-file write,
  streaming SHA-256 and size verification, `fsync`, and atomic `rename`.
- `@tephra/blob-store-s3` and `@tephra/blob-store-r2` are empty placeholder workspaces with no
  source, tests, or dependencies.
- `apps/api/src/main.ts` hardcodes the filesystem driver and throws for any other
  `TEPHRA_BLOB_DRIVER` value.
- There is no capability descriptor, no error taxonomy, no readiness probe, no mount verification,
  and no engine-to-engine migration tool.
- Blob GC (`apps/api/src/blob-gc.ts`) calls `delete` directly and assumes cheap, local deletes.

## Scope

- Extend the storage contract with capabilities, stat, probe, and a typed error taxonomy.
- Add a Node-only driver factory so runtime composition selects an engine from configuration.
- Harden the mounted-disk engine for network filesystems (EFS/NFS) and container volume mounts.
- Implement the S3-compatible object engine, including multipart upload and integrity checks.
- Add one conformance suite executed against every engine, plus a MinIO-backed CI job.
- Add `tephra storage` copy/verify/cleanup commands and a documented cutover path.
- Document the engine × platform support matrix and operational runbooks.

## Non-goals

- Presigned direct browser or plugin uploads to object storage (deferred, protocol change).
- CDN fronting, public object URLs, or unauthenticated blob reads.
- Cross-user or cross-vault deduplication (explicitly forbidden by plan 003).
- Application-layer blob encryption or per-tenant KMS keys.
- Storing blobs in the database.
- FUSE object mounts (`s3fs`, `goofys`, `mountpoint-s3`) as a supported `filesystem` target.
- Multi-writer SQLite over NFS/EFS.
- Replication, tiering, or lifecycle policies between the two engines at runtime.
- Changing `@tephra/blob-store-core` into a Node-only package; it stays type-only and browser-safe.

## Storage contract

### Interface

Extend the core contract on top of the `BlobKey` namespacing introduced by plan 003:

```ts
export interface BlobKey {
  namespace: string; // owner-derived, validated, never raw user input
  hash: string; // lowercase hex SHA-256
}

export interface BlobStoreCapabilities {
  readonly driver: 'filesystem' | 's3';
  readonly strongReadAfterWrite: boolean;
  readonly conditionalCreate: boolean; // If-None-Match / O_EXCL style create-if-absent
  readonly serverSideChecksum: boolean;
  readonly rangeReads: boolean;
  readonly maxObjectBytes: number;
  readonly deleteIsImmediate: boolean;
}

export interface BlobStat {
  size: number;
  mimeType?: string;
  createdAt?: number;
}

export interface BlobStore {
  readonly capabilities: BlobStoreCapabilities;
  has(key: BlobKey): Promise<boolean>;
  stat(key: BlobKey): Promise<BlobStat | null>;
  put(input: BlobPutInput): Promise<void>;
  get(key: BlobKey): Promise<BlobReadResult | null>;
  delete(key: BlobKey): Promise<void>;
  probe(): Promise<void>; // readiness: write, read back, delete a probe object
  close?(): Promise<void>;
}
```

`put` keeps its current semantics on every engine: streaming write, running SHA-256 and byte
count, reject on mismatch, and only then make the object visible under its final key. A second
`put` of an existing key with a matching size is a successful no-op.

`probe` writes, reads, and deletes an object under a reserved `_probe/` namespace with a random
suffix. It never touches tenant namespaces and never leaves residue on success.

### Error taxonomy

Add typed errors in core so callers stop pattern-matching engine-specific codes:

```text
BlobNotFoundError        // read/stat of an absent key
BlobIntegrityError       // hash or size mismatch during put or verify
BlobConflictError        // existing object contradicts the declared size
BlobUnavailableError     // transport, mount, permission, or service failure (retryable flag)
BlobCapacityError        // ENOSPC, quota, or bucket limit
```

Rules:

- Every error carries `retryable: boolean` and an engine-specific `cause`.
- Error messages never include credentials, signed URLs, request signatures, tokens, or vault
  content. Add a redaction regression test per engine.
- API mapping: integrity/conflict → 409, capacity → 507, unavailable → 503 with `Retry-After`,
  not-found → 404 through the existing route handlers.

### Driver factory

Add `@tephra/blob-store-node` (Node-only) exporting:

```ts
export function createBlobStore(config: BlobStoreConfig): Promise<BlobStore>;
export function parseBlobStoreConfig(env: NodeJS.ProcessEnv): BlobStoreConfig;
```

`parseBlobStoreConfig` is total and fail-closed: unknown driver values, missing required
variables, and variables belonging to a different driver are startup errors listing every
offending variable at once. `main.ts` calls the factory instead of importing an engine directly,
and the API keeps depending only on the `BlobStore` type.

Remove the empty `@tephra/blob-store-r2` workspace. R2 is a configuration preset of the `s3`
driver (custom endpoint, `forcePathStyle: false`, no checksum headers), documented rather than
implemented twice.

## Configuration

| Variable                       | Driver     | Required | Notes                                                     |
| ------------------------------ | ---------- | -------- | --------------------------------------------------------- |
| `TEPHRA_BLOB_DRIVER`           | both       | no       | `filesystem` (default) or `s3`                            |
| `TEPHRA_BLOB_PATH`             | filesystem | yes      | Mount point root, e.g. `/data/blobs`                      |
| `TEPHRA_BLOB_REQUIRE_MOUNT`    | filesystem | no       | Default `true` in production; enforces the mount sentinel |
| `TEPHRA_BLOB_FSYNC`            | filesystem | no       | `full` (default), `data`, or `off` for disposable disks   |
| `TEPHRA_BLOB_MIN_FREE_BYTES`   | filesystem | no       | Readiness fails below this headroom                       |
| `TEPHRA_S3_BUCKET`             | s3         | yes      | Private bucket, never public-read                         |
| `TEPHRA_S3_REGION`             | s3         | yes      | `auto` accepted for R2                                    |
| `TEPHRA_S3_ENDPOINT`           | s3         | no       | Required for non-AWS S3-compatible services               |
| `TEPHRA_S3_FORCE_PATH_STYLE`   | s3         | no       | Default `true` when an endpoint is set (MinIO, Ceph)      |
| `TEPHRA_S3_PREFIX`             | s3         | no       | Key prefix for shared buckets; validated, no `..`         |
| `TEPHRA_S3_ACCESS_KEY_ID`      | s3         | no       | Omit to use instance/task/workload identity               |
| `TEPHRA_S3_SECRET_ACCESS_KEY`  | s3         | no       | Required with an access key id                            |
| `TEPHRA_S3_SESSION_TOKEN`      | s3         | no       | Temporary credentials                                     |
| `TEPHRA_S3_SSE`                | s3         | no       | `aes256`, `kms`, or unset                                 |
| `TEPHRA_S3_SSE_KMS_KEY_ID`     | s3         | no       | Required with `kms`                                       |
| `TEPHRA_S3_CHECKSUM`           | s3         | no       | `auto` (default), `sha256`, `off` for strict services     |
| `TEPHRA_S3_PART_SIZE_BYTES`    | s3         | no       | Default 8 MiB, minimum 5 MiB                              |
| `TEPHRA_S3_MAX_CONCURRENCY`    | s3         | no       | Default 4 parts in flight per upload                      |
| `TEPHRA_S3_REQUEST_TIMEOUT_MS` | s3         | no       | Default 30000                                             |
| `TEPHRA_S3_MAX_ATTEMPTS`       | s3         | no       | Default 4, exponential backoff with jitter                |

Validation rules:

- Filesystem variables with `TEPHRA_BLOB_DRIVER=s3` (and the reverse) are configuration errors.
- `TEPHRA_MAX_BLOB_BYTES` must not exceed `capabilities.maxObjectBytes`.
- Plan 004's multi-user mode continues to reject `filesystem`; single-user mode allows either.
- `tephra doctor` prints resolved driver, endpoint host, bucket, prefix, and capabilities — never
  keys or secrets.

## Mounted-disk engine

The existing implementation is correct for local disks. The work is making it honest on network
and container-mounted volumes.

### Mount verification

Silent data loss on Railway/EFS/Compose happens when the volume fails to attach and the process
writes into the container layer instead. On first start the engine writes
`<root>/.tephra-blobstore` containing a JSON marker (format version, created timestamp, random
store id). On every start it:

1. creates the root if absent, then reads the marker;
2. fails startup when `TEPHRA_BLOB_REQUIRE_MOUNT` is enabled and the marker is missing but the
   root already contains blob shards, or the marker's store id changed unexpectedly;
3. records the store id in structured startup logs and `doctor` output.

A missing marker on a genuinely empty root is a first-run initialization, not an error.

### Network filesystem hardening

- Keep temp files in the destination directory so `rename` stays same-filesystem and atomic.
- `fsync` the file and then the containing directory before publishing, gated by
  `TEPHRA_BLOB_FSYNC`; document that `off` trades durability for throughput.
- Treat `EEXIST`/`EPERM` on rename as a concurrent identical write (already handled) and verify
  size before accepting.
- Retry `ESTALE` and `EIO` once after re-opening the path; classify persistent failures as
  `BlobUnavailableError { retryable: true }`.
- Map `ENOSPC`/`EDQUOT` to `BlobCapacityError`, and `EACCES`/`EPERM` on open to a startup-level
  ownership diagnostic (container UID vs volume owner is the common EFS/Railway failure).
- Never use `flock`/`fcntl` locks for correctness; the write path stays lock-free.
- Do not trust `mtime` or directory listings for correctness; existence plus size is the contract.
- `has`/`stat` are metadata round-trips on NFS, so the commit path batches existence checks per
  manifest rather than calling per file in nested loops.

### Readiness and capacity

`probe()` writes an 8-byte probe object, reads it back, compares bytes, and unlinks it.
Readiness additionally calls `statfs` and fails when free space is below
`TEPHRA_BLOB_MIN_FREE_BYTES`, so a full EBS/EFS volume takes the replica out of rotation before
sync commits start failing mid-manifest.

## Object-store engine

Implement `@tephra/blob-store-s3` on `@aws-sdk/client-s3` with `@aws-sdk/lib-storage` for
multipart.

### Key layout

```text
<prefix>/users/<owner-user-uuid>/blobs/<hash[0..2]>/<hash[2..4]>/<hash>
<prefix>/tmp/<upload-uuid>
<prefix>/_probe/<random>
```

The prefix is validated (no leading slash, no `..`, no control characters). Keys are derived
entirely from validated internal identifiers.

### Write path

1. Reject sizes above `capabilities.maxObjectBytes` before reading the stream.
2. Stream the body while computing SHA-256 and byte count, exactly as the filesystem engine does.
3. Below the part threshold, buffer and `PutObject` directly to the final key; above it, use a
   multipart upload to a `tmp/` key so a failed or mismatched upload never occupies the final key.
4. Abort the multipart upload and delete the temporary key on any mismatch or transport failure.
5. On success for the multipart path, `CopyObject` to the final key, then delete the temporary
   object. Failure after copy but before delete leaves collectable garbage, never corruption.
6. When `capabilities.serverSideChecksum` is on, send `ChecksumAlgorithm: SHA256` with the
   base64 digest so the service rejects a corrupted transfer too. Local verification remains
   canonical; the header is defense in depth and is disabled by `TEPHRA_S3_CHECKSUM=off` for
   services that reject the header.
7. When `capabilities.conditionalCreate` is on, send `If-None-Match: *` for immutability; a
   `412`/`PreconditionFailed` means the blob already exists and is treated as success after a
   `HeadObject` size check.

Existing-object short circuit: `HeadObject` first, and if the size matches the declared size,
return without transferring bytes.

### Read, stat, delete

- `get` returns the `GetObject` body as a web `ReadableStream` with `size` from `ContentLength`.
  `NoSuchKey`/`404` returns `null`; the caller's 404 shape does not change.
- `stat` uses `HeadObject`. `NotFound` returns `null`.
- `delete` is idempotent: `NoSuchKey` succeeds.
- Request paths never call `ListObjectsV2`. Listing is reserved for maintenance commands.
- Range reads are advertised through capabilities for a later attachment-streaming change; this
  plan does not change reader routes.

### Reliability

- Timeouts, capped exponential backoff with jitter, and `TEPHRA_S3_MAX_ATTEMPTS` retries for
  5xx/throttling; no retries for 4xx other than the documented conditional-create case.
- A single shared client instance with a keep-alive agent; `close()` destroys it.
- `strongReadAfterWrite` defaults to true for AWS S3, R2, and MinIO, and is configurable off for
  services that do not guarantee it; when off, the commit path re-verifies via `HeadObject` with
  bounded retry before writing metadata.
- Temporary-key cleanup: `tephra storage cleanup-temp --older-than 24h`, plus a documented bucket
  lifecycle rule on the `tmp/` prefix for platforms that support it.

### GC interaction

Blob GC keeps its plan 003 tenant scoping and gains engine awareness: deletions are batched
(`DeleteObjects`, 1000 keys max per request) with per-key error handling, and a failed delete is
logged and retried on the next run instead of aborting the sweep.

## Conformance suite

Add `@tephra/blob-store-conformance` (private, test-only) exporting a factory-driven suite so an
engine cannot ship without passing identical behavior tests:

- put/get round-trip for empty, 1-byte, part-boundary−1, part-boundary, and multi-part sizes;
- `put` rejects a wrong hash, a short body, and an over-long body without publishing the key;
- repeated `put` of the same key is a no-op and preserves the original bytes;
- concurrent `put` of the same key from N callers yields exactly one intact object;
- `get`/`stat` of an absent key return `null`; `delete` of an absent key succeeds;
- namespace isolation: identical hashes in two namespaces are independent for read and delete;
- key traversal attempts (`../`, absolute paths, non-hex hashes) throw before any I/O;
- streaming reads survive early consumer cancellation without leaking handles or client sockets;
- injected mid-stream failure leaves no visible object;
- `probe()` succeeds and leaves no residue;
- errors expose no credentials or signed request material.

Execution:

- filesystem: temp directory, always in CI;
- s3: MinIO service container, required in CI;
- s3 against R2 or a real AWS bucket: optional, credential-gated, skipped by default.

## Migration and cutover

Add `tephra storage` subcommands to the plan 004 CLI:

```text
tephra storage copy --from <driver-config> --to <driver-config> [--namespace <id>] [--resume]
tephra storage verify --driver <driver-config> [--sample 1000 | --all]
tephra storage cleanup-temp --older-than <duration>
```

`copy` enumerates blob rows from the database (not by listing the store), streams each object,
verifies SHA-256 on read and on write, is resumable through a progress ledger, and reports counts
and bytes. `verify` re-reads objects and compares digests against database metadata.

Documented cutover, filesystem → S3:

1. Deploy with the current engine; take a coordinated database + blob backup.
2. Run `tephra storage copy` while the service runs (blobs are immutable, so copies are safe).
3. Stop writes briefly (single-user: stop the container), run a final incremental `copy`, then
   `verify --all` for small installs or `--sample` for large ones.
4. Switch `TEPHRA_BLOB_DRIVER` and restart; confirm `/readyz` and an authenticated read of an
   attachment and a rendered note.
5. Keep the source volume read-only for the rollback window, then delete it deliberately.

Rollback is the same procedure in reverse; because blobs are immutable and content-addressed,
neither direction rewrites data. No dual-write runtime mode is added — it doubles failure modes
for a migration that immutability already makes safe.

## Affected areas

- `tephra-server/packages/blob-store/core/`: capabilities, `stat`, `probe`, error taxonomy.
- `tephra-server/packages/blob-store/filesystem/`: mount sentinel, fsync policy, error mapping,
  NFS retry, free-space checks.
- `tephra-server/packages/blob-store/s3/`: full adapter implementation.
- `tephra-server/packages/blob-store/r2/`: removed; documented as an `s3` preset.
- `tephra-server/packages/blob-store/node/` (new): configuration parsing and driver factory.
- `tephra-server/packages/blob-store/conformance/` (new): shared suite.
- `tephra-server/apps/api/src/main.ts`: factory-based composition and shutdown `close()`.
- `tephra-server/apps/api/src/app.ts`: error taxonomy → HTTP status mapping; batched existence
  checks in the commit path.
- `tephra-server/apps/api/src/blob-gc.ts`: batched, failure-tolerant deletes.
- `tephra-server/apps/api/src/cli.ts`: `storage` subcommands; `doctor` storage section.
- `tephra-server/deploy/`: Compose volume, Railway volume and bucket, AWS EBS/EFS/S3 examples.
- `.env.example`, `tephra-server/.env.example`, root and server READMEs,
  `docs/GETTING_STARTED.md`, `docs/THREAT_MODEL.md`.
- `.github/workflows/`: MinIO service container for the object-store suite.

`@tephra/blob-store-core` stays type-only and browser-safe; every Node and AWS SDK import lives in
the engine packages and the factory.

## Implementation sequence

### Phase 1 — Contract and factory

1. Extend core with capabilities, `stat`, `probe`, and typed errors.
2. Add the conformance package and run it against the existing filesystem engine.
3. Add `@tephra/blob-store-node` config parsing plus the factory, and switch `main.ts` to it.
4. Map the error taxonomy to HTTP statuses with route tests.

Gate: no behavior change for existing installs; `npm run check` passes; the filesystem engine
passes the conformance suite unchanged except for new surface.

### Phase 2 — Mounted-disk hardening

1. Add the mount sentinel, `TEPHRA_BLOB_REQUIRE_MOUNT`, and startup diagnostics.
2. Add fsync policy, free-space readiness, and NFS/EFS error mapping and retries.
3. Add tests for unmounted-root detection, permission mismatch, and `ENOSPC`.
4. Verify on Docker named volume, bind mount, and a local NFS export.

Gate: an unmounted or wrong-owner volume fails readiness instead of writing into the container
filesystem.

### Phase 3 — Object-store engine

1. Implement the client, key builder, and read/stat/delete paths.
2. Implement single-part and multipart writes with verification, temp keys, and promotion.
3. Add capability detection, conditional create, checksum modes, retries, and timeouts.
4. Pass the conformance suite against MinIO in CI and against R2 manually.

Gate: identical sync, browse, attachment, index, and GC behavior on `s3` and `filesystem`.

### Phase 4 — Operations

1. Implement `storage copy`, `storage verify`, `storage cleanup-temp`, and `doctor` output.
2. Add batched GC deletes and temp-object lifecycle documentation.
3. Add the deployment matrix, runbooks, and `.env.example` entries.
4. Execute a full filesystem → S3 cutover and a rollback on a real sample vault.

Gate: a documented cutover moves a real vault between engines with byte-identical content and
unchanged revisions.

## Deployment matrix

| Platform           | Recommended engine | Configuration                                    | Replica limit |
| ------------------ | ------------------ | ------------------------------------------------ | ------------- |
| Docker Compose VPS | `filesystem`       | named volume or bind mount at `/data`            | 1             |
| Railway (volume)   | `filesystem`       | volume mounted at `/data`                        | 1             |
| Railway (bucket)   | `s3`               | project bucket endpoint, path style, secrets     | many          |
| AWS ECS + EBS      | `filesystem`       | single-AZ, single task, stateful service         | 1             |
| AWS ECS + EFS      | `filesystem`       | access point with matching UID/GID, `fsync=full` | 1 writer      |
| AWS ECS/EKS + S3   | `s3`               | task/IRSA role, no static keys, SSE enabled      | many          |
| Cloudflare R2      | `s3`               | endpoint, `region=auto`, `checksum=off`          | many          |
| Self-host MinIO    | `s3`               | endpoint, path style, static keys                | many          |

The database engine constrains replicas independently: SQLite remains single-replica regardless
of the blob engine, so `s3` with SQLite is supported but does not by itself enable scale-out.

## Verification

```bash
npm run check
npm test --workspace=@tephra/blob-store-filesystem
npm test --workspace=@tephra/blob-store-s3
npm test --workspace=@tephra/api
docker compose -f tephra-server/deploy/docker/compose.hosted-test.yml up -d minio
TEPHRA_BLOB_DRIVER=s3 npm run sync:vault
```

Required end-to-end assertions per engine:

- bootstrap, login, plan, upload, commit, recommit idempotency;
- rendered note, raw file, and binary attachment reads byte-identical to the source vault;
- index, links, and graph unchanged between engines for the same vault;
- interrupted upload leaves no readable object and no metadata row;
- GC deletes only unreferenced blobs and tolerates partial delete failures;
- readiness fails on unmounted volume, wrong credentials, missing bucket, and full disk;
- `storage copy` + engine switch reproduces the same vault with the same revisions.

## Risks and mitigations

| Risk                                             | Mitigation                                                              |
| ------------------------------------------------ | ----------------------------------------------------------------------- |
| Volume fails to mount; writes hit container disk | mount sentinel + `TEPHRA_BLOB_REQUIRE_MOUNT` readiness failure          |
| EFS/Railway UID mismatch breaks writes           | startup permission diagnostic and documented access-point/UID setup     |
| Multipart upload leaves partial objects          | temp keys, abort on failure, cleanup command, lifecycle rule            |
| S3-compatible service rejects checksum headers   | capability detection with `TEPHRA_S3_CHECKSUM=off` fallback             |
| Weak read-after-write on a compatible service    | capability flag plus bounded `HeadObject` re-verify before commit       |
| Credentials leak through error text or logs      | sanitized error taxonomy and redaction regression tests                 |
| Bucket accidentally public                       | private-by-default docs, no public URL code path, deploy checklist item |
| Silent divergence between engines                | one conformance suite is mandatory for every engine                     |
| Migration loses or corrupts bytes                | content-addressed copy with verify on read and write, resumable ledger  |
| Object listing on hot paths costs money/latency  | listing is maintenance-only; existence checks use `HeadObject`          |
| Operator scales SQLite replicas after S3 switch  | replica limits stated per engine and enforced by plan 004 validation    |
| Network filesystem latency slows commits         | batched existence checks and documented throughput-mode guidance        |

## Completion checklist

- [ ] One `BlobStore` contract with capabilities, `stat`, `probe`, and typed errors.
- [ ] Runtime selects the engine from configuration; unsafe configuration fails before listening.
- [ ] Mounted-disk engine detects unmounted roots, ownership problems, and low free space.
- [ ] Object engine implements verified streaming single-part and multipart writes.
- [ ] `@tephra/blob-store-r2` placeholder removed and documented as an `s3` preset.
- [ ] Conformance suite passes for filesystem and S3-compatible storage in CI.
- [ ] GC, sync, index, and reader paths behave identically on both engines.
- [ ] `storage copy`/`verify`/`cleanup-temp` implemented and exercised on a real vault.
- [ ] Deployment matrix, runbooks, and environment examples updated.
- [ ] No credentials or vault content appear in logs or error messages.
- [ ] `npm run check` passes.

## References

- `001-TEPHRA_STAGE1_PLAN.md`, sections 14–16, 27–30, and 36–37 for blob and sync invariants.
- `003-MULTI_TENANT_PERSISTENCE.md` for `BlobKey` namespacing, quotas, and tenant-scoped GC.
- `004-DEPLOYMENT_PROFILES.md` for profile/storage compatibility and the CLI command contract.
- [Amazon S3 multipart upload](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html)
- [Amazon S3 checking object integrity](https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity.html)
- [Amazon EFS performance and NFS behavior](https://docs.aws.amazon.com/efs/latest/ug/performance.html)
- [Cloudflare R2 S3 API compatibility](https://developers.cloudflare.com/r2/api/s3/api/)
- [Railway volumes](https://docs.railway.com/reference/volumes)
