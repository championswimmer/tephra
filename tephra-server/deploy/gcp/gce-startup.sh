#!/bin/bash
# GCE startup script for Tephra (disk-only, single tenant).
# Attaches the pre-created Persistent Disk as /data, installs Docker +
# Compose, and starts the Tephra stack. Replace every <PLACEHOLDER>.
set -euo pipefail

DATA_DISK="${DATA_DISK:-tephra-data}"
MOUNT_POINT="/data"
TEPHRA_DIR="/opt/tephra"
PUBLIC_URL="<HTTPS_PUBLIC_URL>"

# Resolve the PD device (by-name symlink is stable across attaches).
DEVICE="/dev/disk/by-id/google-${DATA_DISK}"
for i in $(seq 1 30); do
  [ -e "${DEVICE}" ] && break
  sleep 2
done
[ -e "${DEVICE}" ] || { echo "disk ${DEVICE} not found" >&2; exit 1; }

# Format only if brand new (never reformat an existing Tephra disk).
if ! blkid "${DEVICE}" >/dev/null 2>&1; then
  mkfs.ext4 -m 0 -E lazy_itable_init=0 "${DEVICE}"
fi
mkdir -p "${MOUNT_POINT}"
if ! mountpoint -q "${MOUNT_POINT}"; then
  mount -o discard,defaults "${DEVICE}" "${MOUNT_POINT}"
fi
grep -q "${MOUNT_POINT}" /etc/fstab || \
  echo "${DEVICE} ${MOUNT_POINT} ext4 discard,defaults,nofail 0 2" >> /etc/fstab
chown -R 1000:1000 "${MOUNT_POINT}"

# Docker + Compose plugin (Debian 12).
if ! command -v docker >/dev/null 2>&1; then
  apt-get update
  apt-get install -y ca-certificates curl gnupg
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
  systemctl enable --now docker
fi

# Secrets: prefer Secret Manager at provision time; fall back to existing env file.
mkdir -p "${TEPHRA_DIR}"
ENV_FILE="${TEPHRA_DIR}/tephra.env"
if [ ! -f "${ENV_FILE}" ]; then
  TEPHRA_SESSION_SECRET="$(gcloud secrets versions access latest --secret=<SESSION_SECRET_NAME> 2>/dev/null || openssl rand -hex 32)"
  TEPHRA_BOOTSTRAP_TOKEN="$(gcloud secrets versions access latest --secret=<BOOTSTRAP_SECRET_NAME> 2>/dev/null || openssl rand -hex 32)"
  cat > "${ENV_FILE}" <<EOF
TEPHRA_PUBLIC_URL=${PUBLIC_URL}
TEPHRA_SESSION_SECRET=${TEPHRA_SESSION_SECRET}
TEPHRA_BOOTSTRAP_TOKEN=${TEPHRA_BOOTSTRAP_TOKEN}
EOF
  chmod 600 "${ENV_FILE}"
  echo "BOOTSTRAP_TOKEN=${TEPHRA_BOOTSTRAP_TOKEN} (complete /setup once, then remove TEPHRA_BOOTSTRAP_TOKEN)" | tee /var/log/tephra-bootstrap.log
  chmod 600 /var/log/tephra-bootstrap.log
fi

# Compose bundle (Tephra + optional headless Sync sidecar overlay).
cp /opt/tephra-bundle/gce-compose.yml "${TEPHRA_DIR}/compose.yml" 2>/dev/null || true
docker compose --env-file "${ENV_FILE}" -f "${TEPHRA_DIR}/compose.yml" up -d
