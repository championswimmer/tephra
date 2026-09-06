# GCP deployment (disk-only)

Two reference paths run the same Node Docker image on GCP with persistent
disk at `/data` (SQLite at `/data/tephra.db` + filesystem blobs at
`/data/blobs`, plus `checkouts/`, `sync-state/`, `snapshots/` per the
disk-only doctrine in `.agents/plans/003-MULTI_TENANT_PERSISTENCE.md`).
One tenant = one VM/disk or one Cloud Run service + Filestore share.
Never attach two writers to one disk.

> Status: reference skeletons — follow the same honesty rule as AWS: do not
> present as supported until a clean-environment smoke passes.

## Files

| File | Purpose |
| ---- | ------- |
| `gce-startup.sh` | GCE startup script: installs Docker, mounts the PD at `/data`, runs Compose |
| `gce-compose.yml` | Compose bundle for the VM (Tephra + optional Sync sidecar) |
| `cloudrun-service.yaml` | Cloud Run service skeleton (Filestore NFS at `/data`, min=max=1) |
| `README.md` | This guide |

Every `<PLACEHOLDER>` must be replaced before use. Nothing here contains real
project IDs, IPs, or secrets.

## Option 1 — Compute Engine VM + Persistent Disk (recommended first)

1. Create one balanced Persistent Disk per tenant (e.g. 10 GB is ample for a
   personal vault; grow later with `gcloud compute disks resize`):
   `gcloud compute disks create tephra-data --size=10GB --type=pd-balanced --zone=<ZONE>`.
2. Create the VM with the disk attached and the startup script:
   `gcloud compute instances create tephra --zone=<ZONE> --machine-type=e2-micro --image-family=debian-12 --image-project=debian-cloud --disk=name=tephra-data,mode=rw --metadata-from-file=startup-script=gce-startup.sh`.
3. Reserve a static IP + DNS A record; terminate TLS with the platform LB or
   Caddy/Traefik on the VM; set `TEPHRA_PUBLIC_URL` to the HTTPS origin.
4. Secrets (`TEPHRA_SESSION_SECRET`, `TEPHRA_BOOTSTRAP_TOKEN`) via Secret
   Manager, injected as env at first boot; complete `/setup` once, then delete
   the bootstrap secret value.
5. Backups: `tephra snapshot create` + `snapshot upload` to a private GCS
   bucket (backup only), plus scheduled PD snapshots
   (`gcloud compute disks snapshot`).

## Option 2 — Cloud Run + Filestore

1. Create a Filestore Basic NFS share + VPC connector in the service region.
2. Deploy from `cloudrun-service.yaml` (NFS volume at `/data`,
   `--min-instances 1 --max-instances 1` — scale-out is forbidden on one disk).
3. HTTPS is built in; set `TEPHRA_PUBLIC_URL` to the service URL or custom domain.
4. Secrets via Secret Manager (`--set-secrets`); same first-boot flow.
5. Snapshots to private GCS via Cloud Scheduler hitting an operator command
   path, or a periodic GCE helper — never from request-serving code.

## Notes and limits

- Container liveness uses `/healthz`; LB/readiness uses `/readyz`.
- Back up the disk (PD snapshots or Filestore backups) and test restores;
  treat backups as private data.
- Object storage (GCS) holds snapshot tarballs only — never live blobs.
- One tenant = one VM/disk or one service/share. More tenants = more of the same.
