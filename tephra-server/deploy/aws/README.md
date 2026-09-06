# AWS deployment profiles

## Simple self-hosted profile

Run `tephra-server/deploy/docker/Dockerfile` on a single EC2 or Lightsail instance. Publish
port 8080 only through an HTTPS reverse proxy or load balancer, and attach durable storage
mounted at `/data`. Configure the same SQLite/filesystem variables documented in the
server README.

Use one container replica with this profile. Stop the service for a simple consistent
volume backup, or use the SQLite online backup procedure and copy blobs from the same
point in time. Encrypt snapshots, restrict security groups, and do not put secrets in the
image, user-data scripts, or repository.

## Scalable adapter contract

A horizontally scaled AWS deployment requires:

- the Node API/web container on ECS/Fargate or EC2,
- the PostgreSQL adapter backed by RDS,
- the S3 blob-store adapter backed by a private bucket,
- task-role credentials where supported instead of static access keys,
- migrations serialized across deployments, and
- optional CloudFront only after private-content authorization and caching behavior have
  been reviewed.

The checked-in assets do not provision this architecture. Treat it as an adapter and
infrastructure contract until the PostgreSQL/S3 adapters and infrastructure are tested in
the target release. Never use container-local SQLite or blobs with multiple tasks.
