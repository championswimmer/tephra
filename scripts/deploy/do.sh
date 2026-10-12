#!/usr/bin/env bash
# Deploy Tephra to DigitalOcean: Droplet + Volume (/data) + Reserved IP, Docker Compose + Caddy (auto HTTPS).
# Needs: doctl (authenticated: `doctl auth init`), openssl, ssh key already added to your DO account.
#
# Usage:  DOMAIN=notes.example.com [REGION=nyc3] [SIZE=s-1vcpu-2gb] [NAME=tephra] \
#         [VOLUME_GB=10] [DNS_ZONE=example.com] [REPO=https://github.com/championswimmer/tephra.git] \
#         [REF=main] ./scripts/deploy/do.sh
#   DNS_ZONE: set only if that domain is hosted in DO DNS (creates the A record); otherwise add it yourself.
# Secrets go only into the droplet's user-data (root-only 600 env file); they are never printed.
set -euo pipefail

: "${DOMAIN:?set DOMAIN, e.g. notes.example.com}"
REGION="${REGION:-nyc3}"
SIZE="${SIZE:-s-1vcpu-2gb}"
NAME="${NAME:-tephra}"
VOLUME_GB="${VOLUME_GB:-10}"
REPO="${REPO:-https://github.com/championswimmer/tephra.git}"
REF="${REF:-main}"
DNS_ZONE="${DNS_ZONE:-}"

command -v doctl >/dev/null || { echo "doctl not found" >&2; exit 1; }
command -v openssl >/dev/null || { echo "openssl not found" >&2; exit 1; }

SESSION_SECRET="$(openssl rand -hex 32)"
BOOTSTRAP_TOKEN="$(openssl rand -hex 32)"
SSH_KEYS="$(doctl compute ssh-key list --no-header --format ID | paste -sd, -)"
[ -n "${SSH_KEYS}" ] || { echo "add an SSH key to your DO account first" >&2; exit 1; }

USERDATA="$(mktemp)"
trap 'rm -f "${USERDATA}"' EXIT
chmod 600 "${USERDATA}"
cat > "${USERDATA}" <<EOF
#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
DOMAIN='${DOMAIN}'; VOL='${NAME}-data'; REPO='${REPO}'; REF='${REF}'
mkdir -p /opt/tephra /data
cd /opt/tephra

# Volume -> /data (format only if blank)
DEV="/dev/disk/by-id/scsi-0DO_Volume_\${VOL}"
for _ in \$(seq 1 60); do [ -e "\$DEV" ] && break; sleep 2; done
blkid "\$DEV" >/dev/null 2>&1 || mkfs.ext4 -m 0 "\$DEV"
grep -q ' /data ' /etc/fstab || echo "\$DEV /data ext4 defaults,nofail,discard 0 2" >> /etc/fstab
mountpoint -q /data || mount /data
chown -R 1000:1000 /data

# Docker (official convenience script) + git
curl -fsSL https://get.docker.com | sh
apt-get install -y git

# Secrets (root-only)
umask 077
cat > tephra.env <<ENV
TEPHRA_PUBLIC_URL=https://\${DOMAIN}
TEPHRA_SESSION_SECRET=${SESSION_SECRET}
TEPHRA_BOOTSTRAP_TOKEN=${BOOTSTRAP_TOKEN}
DOMAIN=\${DOMAIN}
ENV
chmod 600 tephra.env
umask 022

# Build image from source
git clone --depth 1 --branch "\$REF" "\$REPO" src
docker build -t tephra:local -f src/tephra-server/deploy/docker/Dockerfile src

cat > Caddyfile <<CADDY
{\\\$DOMAIN} {
  reverse_proxy tephra:8080
}
CADDY

cat > compose.yml <<'YML'
services:
  tephra:
    image: tephra:local
    restart: unless-stopped
    init: true
    environment:
      PORT: '8080'
      HOST: '0.0.0.0'
      TEPHRA_PUBLIC_URL: '\${TEPHRA_PUBLIC_URL}'
      TEPHRA_SESSION_SECRET: '\${TEPHRA_SESSION_SECRET}'
      TEPHRA_BOOTSTRAP_TOKEN: '\${TEPHRA_BOOTSTRAP_TOKEN:-}'
      TEPHRA_DATABASE_DRIVER: 'sqlite'
      TEPHRA_SQLITE_PATH: '/data/tephra.db'
      TEPHRA_BLOB_DRIVER: 'filesystem'
      TEPHRA_BLOB_PATH: '/data/blobs'
    volumes:
      - /data:/data
    security_opt:
      - no-new-privileges:true
  caddy:
    image: caddy:2
    restart: unless-stopped
    ports: ['80:80', '443:443']
    environment:
      DOMAIN: '\${DOMAIN}'
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - /data/caddy:/data
YML
docker compose --env-file tephra.env up -d
EOF

echo "Creating volume ${NAME}-data (${VOLUME_GB} GB) and droplet ${NAME} in ${REGION}..."
doctl compute volume create "${NAME}-data" --region "${REGION}" --size "${VOLUME_GB}GiB" >/dev/null
doctl compute droplet create "${NAME}" --region "${REGION}" --size "${SIZE}" \
  --image ubuntu-24-04-x64 --ssh-keys "${SSH_KEYS}" --volumes "$(doctl compute volume list --no-header --format ID,Name | awk -v n="${NAME}-data" '$2==n{print $1}')" \
  --user-data-file "${USERDATA}" --wait >/dev/null
DROPLET_ID="$(doctl compute droplet list --no-header --format ID,Name | awk -v n="${NAME}" '$2==n{print $1}')"

IP="$(doctl compute reserved-ip create --droplet-id "${DROPLET_ID}" --no-header --format IP)"
echo "Reserved IP: ${IP}"

if [ -n "${DNS_ZONE}" ]; then
  SUB="${DOMAIN%."${DNS_ZONE}"}"
  [ "${SUB}" = "${DOMAIN}" ] && SUB="@"
  doctl compute domain records create "${DNS_ZONE}" --record-type A --record-name "${SUB}" --record-data "${IP}" --record-ttl 300 >/dev/null
  echo "DNS A record created: ${DOMAIN} -> ${IP}"
else
  echo "Create DNS: A ${DOMAIN} -> ${IP}"
fi

cat <<MSG
Wait ~5 min for the first build, then open https://${DOMAIN}/setup
Bootstrap token (one-time; read on the droplet, not printed here):
  ssh root@${IP} grep BOOTSTRAP /opt/tephra/tephra.env
After setup: delete the TEPHRA_BOOTSTRAP_TOKEN line, then 'docker compose --env-file tephra.env up -d' in /opt/tephra.
MSG
