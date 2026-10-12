# Deploy Tephra on AWS

One EC2 instance + 20 GB EBS at `/data`, Docker Compose, Caddy for HTTPS.
(Managed alternative: ECS/Fargate + EFS in `tephra-server/deploy/aws/`.)

## Infra at a glance

```mermaid
flowchart LR
  U["Browser / Obsidian plugin"]
  DNS["Route 53 or any DNS<br/>A notes"]
  subgraph AWS["AWS account"]
    EIP["Elastic IP<br/>+ security group 80/443"]
    subgraph EC2["EC2 instance (Ubuntu)"]
      CADDY["Caddy<br/>auto HTTPS"]
      APP["Tephra container<br/>API + web app"]
    end
    EBS[("EBS gp3 /data<br/>SQLite + blobs")]
    ENV["/opt/tephra/.env (600)<br/>SESSION_SECRET<br/>BOOTSTRAP_TOKEN"]
  end
  DNS --> EIP --> CADDY --> APP
  APP --- EBS
  ENV -.-> APP
  U -->|HTTPS| DNS

  class U actor;
  class DNS meta;
  class EIP,CADDY edge;
  class APP run;
  class EBS data;
  class ENV secret;
  classDef actor fill:#E0F2FE,stroke:#0369A1,color:#0C4A6E;
  classDef edge fill:#FFEDD5,stroke:#EA580C,color:#7C2D12;
  classDef run fill:#DCFCE7,stroke:#16A34A,color:#14532D;
  classDef data fill:#FEE2E2,stroke:#DC2626,color:#7F1D1D;
  classDef secret fill:#F5F3FF,stroke:#7C3AED,color:#4C1D95;
  classDef meta fill:#F3F4F6,stroke:#6B7280,color:#1F2937;
```

Colors: blue = users, orange = network edge, green = compute, red = data, purple = secrets, gray = DNS/meta.

## One-click CloudFormation

[![Launch Stack](https://s3.amazonaws.com/cloudformation-examples/cloudformation-launch-stack.png)](https://console.aws.amazon.com/cloudformation/home#/stacks/create/review?stackName=tephra&templateURL=https%3A%2F%2Fs3.amazonaws.com%2FYOUR-BUCKET%2Ftephra.yaml)

Template: `tephra-server/deploy/aws/cloudformation.yaml` (EC2, encrypted EBS, Elastic IP; secrets generated in Secrets Manager, never in user-data). CloudFormation only accepts S3 template URLs, so either:

```sh
# A) no hosting needed
aws cloudformation deploy --stack-name tephra --capabilities CAPABILITY_IAM \
  --template-file tephra-server/deploy/aws/cloudformation.yaml \
  --parameter-overrides DomainName=notes.example.com

# B) host once, then the button above works (replace YOUR-BUCKET in its URL)
aws s3 cp tephra-server/deploy/aws/cloudformation.yaml s3://YOUR-BUCKET/tephra.yaml
```

Then: point `A notes.example.com` at the `ElasticIp` output, run the `BootstrapTokenCommand` output to get the setup token, and open `/setup`.

## Quick: one command

```sh
DOMAIN=notes.example.com HOSTED_ZONE_ID=Z123 scripts/deploy/aws.sh
```

`HOSTED_ZONE_ID` and `REGION` (default `us-east-1`) are optional. Skip to step 5.

## Manual

1. Launch Ubuntu 24.04, `t3.small`, add a 20 GB gp3 EBS volume.
2. Security group: inbound TCP 80 and 443 only. No SSH.
3. Allocate an Elastic IP and attach it to the instance.
4. DNS: `A notes.example.com -> <Elastic IP>` (Route 53 or any DNS).
5. Secrets (never commit, never paste in chat):
   ```sh
   openssl rand -hex 32   # TEPHRA_SESSION_SECRET
   openssl rand -hex 24   # TEPHRA_BOOTSTRAP_TOKEN
   ```
   Keep them in `/opt/tephra/.env` (`chmod 600`). Prefer SSM Parameter Store SecureString if you use an instance role.
6. Set `TEPHRA_PUBLIC_URL=https://notes.example.com` in the same file.
7. Mount EBS at `/data`, build the image, run compose (see user-data in the script).
8. Open `https://notes.example.com/setup`, create the first user with the bootstrap token.
9. Remove `TEPHRA_BOOTSTRAP_TOKEN` from `.env` / SSM, then `docker compose up -d`.

## Notes

- Back up by snapshotting the EBS volume. Keep one instance only (SQLite).
- Logs: `docker compose logs -f` in `/opt/tephra`.
