# AWS deployment

Two checked-in skeletons deploy the existing Node Docker image to ECS on
Fargate behind an Application Load Balancer, with persistent storage on EFS.
They cover the stateful single-replica profile (SQLite + filesystem blobs at
`/data`, one tenant per service+access-point). Field names follow the ECS task-definition parameters reference
(docs.aws.amazon.com, researched September 2026).

## Files

| File                            | Purpose                                                      |
| ------------------------------- | ------------------------------------------------------------ |
| `ecs-taskdef.stateful-efs.json` | Task definition: image, port 8080, env, secrets, EFS `/data` |
| `ecs-service.stateful-alb.json` | Service: one task, ALB target group, health grace period     |

Every `<PLACEHOLDER>` must be replaced before use. Nothing here contains real
IDs, ARNs, or secrets.

## Prerequisites

- The production image built from the repository root:
  `docker build -f tephra-server/deploy/docker/Dockerfile -t tephra:<TAG> .`,
  pushed to ECR.
- An ECS cluster, a public ALB with an ACM certificate, and private subnets
  with EFS mount targets in every AZ the tasks may use.
- An EFS filesystem plus an access point for Tephra (POSIX UID/GID 1000 to
  match the image's `node` user), e.g. created alongside the environment.
- Secrets in Secrets Manager or SSM Parameter Store:
  `TEPHRA_SESSION_SECRET` and `TEPHRA_BOOTSTRAP_TOKEN` (independent
  high-entropy values, e.g. `openssl rand -hex 32` each).
- An execution role (image pull + secret injection + awslogs) and a task role
  (EFS client + snapshot upload to S3), per the ECS IAM roles documentation.

## Deploy

1. Copy both JSON files out of the repo (or reference them from your
   infrastructure tooling) and fill in every placeholder.
2. Register the task definition:
   `aws ecs register-task-definition --cli-input-json file://ecs-taskdef.stateful-efs.json`.
3. Create the ALB target group first: target type **ip** (required for
   `awsvpc`), protocol HTTP, port 8080, health-check path `/readyz`
   (readiness, including storage connectivity). HTTPS terminates at the ALB;
   keep the container on plain HTTP 8080.
4. Create the service:
   `aws ecs create-service --cli-input-json file://ecs-service.stateful-alb.json`.
   Keep `desiredCount` at **1** — SQLite and filesystem blobs are not shared
   between tasks.
5. Set your DNS/ALB to HTTPS with an HTTP→HTTPS redirect, and set
   `TEPHRA_PUBLIC_URL` to the public HTTPS origin.
6. Open the app, complete first-user bootstrap once, then **delete the
   bootstrap token value** from Secrets Manager/SSM (the endpoint is
   permanently disabled after the first user exists).

## Notes and limits

- The image's `VOLUME ["/data"]` is metadata only; persistence comes from the
  EFS mount declared in the task definition. Use transit encryption and the
  access point as shown in the skeleton.
- EBS on Fargate is a poor fit here (one volume per task at launch, single-AZ,
  snapshot/restore needed across redeploys). Prefer EFS for this profile.
- Container liveness uses `/healthz`; ALB readiness uses `/readyz`.
- Back up EFS (AWS Backup or equivalent) and test restores; treat backups as
  private data and encrypt them off-host.

## Scaled profile (more tenants, not bigger shared infra)

More tenants means more independent single-task services (or EC2 instances),
each with its own EFS access point or EBS volume — never a shared database.
Object storage (private S3) holds periodic snapshot tarballs only
(`tephra snapshot upload`), never live blobs. Serialize per-instance
migrations across deployments. Never run multiple tasks against one
SQLite file or blob directory.

## Why no Copilot manifest or `apprunner.yaml` here

- AWS Copilot CLI support ends 2026-06-12 (AWS announcement), so the checked-in
  path targets ECS directly instead of a Copilot manifest.
- `apprunner.yaml` only configures source-code App Runner services and has no
  persistent-volume support, so it cannot host the `/data` profile. A future
  stateless (Postgres + S3) profile could evaluate App Runner separately.
