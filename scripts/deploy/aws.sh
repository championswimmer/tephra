#!/usr/bin/env bash
# Deploy Tephra to one EC2 instance (+ EBS at /data, Elastic IP, Caddy HTTPS).
# Usage: DOMAIN=notes.example.com [REGION=us-east-1] [HOSTED_ZONE_ID=Z123] \
#        [INSTANCE_TYPE=t3.small] [REPO=https://github.com/championswimmer/tephra.git] \
#        scripts/deploy/aws.sh
# Needs: aws CLI (configured), openssl. Uses the default VPC.
# Secrets are generated locally, never printed; saved to ~/.tephra-aws-<DOMAIN>.env (600).
# Note: secrets are passed via EC2 user-data (readable by account admins/IMDS).
set -euo pipefail

: "${DOMAIN:?set DOMAIN, e.g. notes.example.com}"
REGION="${REGION:-us-east-1}"
HOSTED_ZONE_ID="${HOSTED_ZONE_ID:-}"
INSTANCE_TYPE="${INSTANCE_TYPE:-t3.small}"
REPO="${REPO:-https://github.com/championswimmer/tephra.git}"
export AWS_DEFAULT_REGION="$REGION" AWS_PAGER=""

SECRETS_FILE="$HOME/.tephra-aws-${DOMAIN}.env"
if [ ! -f "$SECRETS_FILE" ]; then
  umask 077
  {
    echo "TEPHRA_SESSION_SECRET=$(openssl rand -hex 32)"
    echo "TEPHRA_BOOTSTRAP_TOKEN=$(openssl rand -hex 24)"
  } >"$SECRETS_FILE"
fi
SECRETS="$(cat "$SECRETS_FILE")"

AMI="$(aws ssm get-parameter --name /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id --query Parameter.Value --output text)"
VPC="$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)"

SG="$(aws ec2 create-security-group --group-name "tephra-${DOMAIN}" --description "tephra 80/443" --vpc-id "$VPC" --query GroupId --output text)"
for p in 80 443; do
  aws ec2 authorize-security-group-ingress --group-id "$SG" --protocol tcp --port "$p" --cidr 0.0.0.0/0 >/dev/null
done

USERDATA="$(mktemp)"
trap 'rm -f "$USERDATA"' EXIT
cat >"$USERDATA" <<UD
#!/bin/bash
set -euxo pipefail
apt-get update && apt-get install -y docker.io docker-compose-v2 git
DEV=/dev/nvme1n1; [ -b \$DEV ] || DEV=/dev/sdf
blkid \$DEV || mkfs.ext4 -L tephra-data \$DEV
mkdir -p /data && echo 'LABEL=tephra-data /data ext4 defaults,nofail 0 2' >> /etc/fstab && mount -a
mkdir -p /data/tephra /opt/tephra && chown 1000:1000 /data/tephra
git clone --depth 1 $REPO /opt/tephra/src
docker build -f /opt/tephra/src/tephra-server/deploy/docker/Dockerfile -t tephra:local /opt/tephra/src
umask 077
cat > /opt/tephra/.env <<'ENV'
$SECRETS
TEPHRA_PUBLIC_URL=https://$DOMAIN
ENV
umask 022
cat > /opt/tephra/compose.yml <<'YML'
services:
  tephra:
    image: tephra:local
    restart: unless-stopped
    init: true
    env_file: .env
    environment:
      PORT: '8080'
      HOST: '0.0.0.0'
      TEPHRA_DATABASE_DRIVER: sqlite
      TEPHRA_SQLITE_PATH: /data/tephra.db
      TEPHRA_BLOB_DRIVER: filesystem
      TEPHRA_BLOB_PATH: /data/blobs
    volumes:
      - /data/tephra:/data
  caddy:
    image: caddy:2
    restart: unless-stopped
    ports: ['80:80', '443:443']
    command: caddy reverse-proxy --from $DOMAIN --to tephra:8080
    volumes:
      - caddy:/data
volumes:
  caddy:
YML
cd /opt/tephra && docker compose up -d
UD

IID="$(aws ec2 run-instances --image-id "$AMI" --instance-type "$INSTANCE_TYPE" \
  --security-group-ids "$SG" --user-data "file://$USERDATA" \
  --metadata-options HttpTokens=required \
  --block-device-mappings \
    '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":16,"VolumeType":"gp3"}},{"DeviceName":"/dev/sdf","Ebs":{"VolumeSize":20,"VolumeType":"gp3","Encrypted":true,"DeleteOnTermination":false}}]' \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=tephra-${DOMAIN}}]" \
  --query 'Instances[0].InstanceId' --output text)"
aws ec2 wait instance-running --instance-ids "$IID"

ALLOC="$(aws ec2 allocate-address --domain vpc --query AllocationId --output text)"
aws ec2 associate-address --instance-id "$IID" --allocation-id "$ALLOC" >/dev/null
IP="$(aws ec2 describe-addresses --allocation-ids "$ALLOC" --query 'Addresses[0].PublicIp' --output text)"

if [ -n "$HOSTED_ZONE_ID" ]; then
  aws route53 change-resource-record-sets --hosted-zone-id "$HOSTED_ZONE_ID" --change-batch \
    "{\"Changes\":[{\"Action\":\"UPSERT\",\"ResourceRecordSet\":{\"Name\":\"$DOMAIN\",\"Type\":\"A\",\"TTL\":300,\"ResourceRecords\":[{\"Value\":\"$IP\"}]}}]}" >/dev/null
  echo "Route 53 A record set: $DOMAIN -> $IP"
else
  echo "Create DNS A record: $DOMAIN -> $IP"
fi
echo "Instance $IID. Wait ~5 min, then open https://$DOMAIN/setup"
echo "Bootstrap token is in $SECRETS_FILE"
