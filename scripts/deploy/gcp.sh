#!/usr/bin/env bash
# Deploy Tephra to one GCE VM + Persistent Disk, with Caddy for HTTPS.
# Usage: PROJECT=my-proj ZONE=us-central1-a DOMAIN=notes.example.com \
#        scripts/deploy/gcp.sh
# Optional: NAME=tephra DISK_GB=10 MACHINE=e2-small
#   IMAGE=us-docker.pkg.dev/my-proj/tephra/tephra:latest  (pull a prebuilt image;
#   if unset, the VM clones REPO and builds the image on first boot, ~5 min)
#   REPO=https://github.com/championswimmer/tephra.git
# Needs: gcloud (logged in), openssl. Secrets live in Secret Manager; never printed.
set -euo pipefail

: "${PROJECT:?set PROJECT}" "${ZONE:?set ZONE}" "${DOMAIN:?set DOMAIN}"
IMAGE="${IMAGE:-}"
REPO="${REPO:-https://github.com/championswimmer/tephra.git}"
if [ -n "$IMAGE" ]; then
  PULL_CMD="gcloud auth configure-docker --quiet ${IMAGE%%/*} >/dev/null 2>&1 || true"
else
  IMAGE="tephra:local"
  PULL_CMD="docker image inspect tephra:local >/dev/null 2>&1 || { apt-get install -y git && git clone --depth 1 $REPO /opt/tephra-src && docker build -f /opt/tephra-src/tephra-server/deploy/docker/Dockerfile -t tephra:local /opt/tephra-src; }"
fi
NAME="${NAME:-tephra}"
DISK_GB="${DISK_GB:-10}"
MACHINE="${MACHINE:-e2-small}"
REGION="${ZONE%-*}"
G=(gcloud --project "$PROJECT" --quiet)

"${G[@]}" services enable compute.googleapis.com secretmanager.googleapis.com

# Secrets (created once; existing values are kept).
for s in session-secret bootstrap-token; do
  secret="$NAME-$s"
  if ! "${G[@]}" secrets describe "$secret" >/dev/null 2>&1; then
    openssl rand -hex 32 | "${G[@]}" secrets create "$secret" --data-file=-
  fi
done

# Static IP, firewall, data disk.
"${G[@]}" compute addresses describe "$NAME-ip" --region "$REGION" >/dev/null 2>&1 ||
  "${G[@]}" compute addresses create "$NAME-ip" --region "$REGION"
"${G[@]}" compute firewall-rules describe "$NAME-web" >/dev/null 2>&1 ||
  "${G[@]}" compute firewall-rules create "$NAME-web" --allow tcp:80,tcp:443 --target-tags "$NAME"
"${G[@]}" compute disks describe "$NAME-data" --zone "$ZONE" >/dev/null 2>&1 ||
  "${G[@]}" compute disks create "$NAME-data" --zone "$ZONE" --size "${DISK_GB}GB" --type pd-balanced

# Startup script: mount disk, install Docker, write env from Secret Manager, run Tephra + Caddy.
STARTUP="$(mktemp)"; trap 'rm -f "$STARTUP"' EXIT
cat >"$STARTUP" <<STARTUP_EOF
#!/bin/bash
set -euo pipefail
DEV=/dev/disk/by-id/google-$NAME-data
blkid "\$DEV" >/dev/null 2>&1 || mkfs.ext4 -m 0 "\$DEV"
mkdir -p /data; mountpoint -q /data || mount -o discard,defaults "\$DEV" /data
grep -q ' /data ' /etc/fstab || echo "\$DEV /data ext4 discard,defaults,nofail 0 2" >> /etc/fstab
chown 1000:1000 /data
command -v docker >/dev/null || { apt-get update && apt-get install -y docker.io docker-compose; }
$PULL_CMD
mkdir -p /opt/tephra; cd /opt/tephra
sec() { gcloud secrets versions access latest --secret="$NAME-\$1"; }
if [ ! -f tephra.env ]; then
  umask 077
  { echo "TEPHRA_PUBLIC_URL=https://$DOMAIN"
    echo "TEPHRA_SESSION_SECRET=\$(sec session-secret)"
    echo "TEPHRA_BOOTSTRAP_TOKEN=\$(sec bootstrap-token)"; } > tephra.env
fi
printf '%s {\n  reverse_proxy tephra:8080\n}\n' "$DOMAIN" > Caddyfile
cat > compose.yml <<'YML'
services:
  tephra:
    image: $IMAGE
    restart: unless-stopped
    env_file: tephra.env
    environment:
      HOST: 0.0.0.0
      PORT: "8080"
      TEPHRA_DATABASE_DRIVER: sqlite
      TEPHRA_SQLITE_PATH: /data/tephra.db
      TEPHRA_BLOB_DRIVER: filesystem
      TEPHRA_BLOB_PATH: /data/blobs
    volumes: ["/data:/data"]
  caddy:
    image: caddy:2
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    volumes: ["./Caddyfile:/etc/caddy/Caddyfile:ro", "caddy:/data"]
volumes:
  caddy:
YML
docker-compose up -d
STARTUP_EOF

if ! "${G[@]}" compute instances describe "$NAME" --zone "$ZONE" >/dev/null 2>&1; then
  "${G[@]}" compute instances create "$NAME" --zone "$ZONE" --machine-type "$MACHINE" \
    --image-family debian-12 --image-project debian-cloud \
    --disk "name=$NAME-data,mode=rw,device-name=$NAME-data" \
    --address "$NAME-ip" --tags "$NAME" --scopes cloud-platform \
    --metadata-from-file "startup-script=$STARTUP"
fi

IP="$("${G[@]}" compute addresses describe "$NAME-ip" --region "$REGION" --format 'value(address)')"
echo "Done. Create DNS: A $DOMAIN -> $IP"
echo "Then open https://$DOMAIN/setup. Token: gcloud secrets versions access latest --secret=$NAME-bootstrap-token"
