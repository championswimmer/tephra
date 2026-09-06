# Stage 1 Compatibility

## Supported baseline

- Node.js 22 LTS
- npm 10+
- Modern evergreen browsers with Web Crypto
- Current Obsidian desktop and mobile APIs supported by the plugin manifest
- SQLite plus filesystem blobs for the reference self-hosted deployment

## Markdown scope

Stage 1 supports CommonMark-style Markdown, YAML frontmatter metadata, headings, tags, Markdown links, Obsidian wikilinks, heading/block subpaths, and image/PDF attachments. It does not execute arbitrary Obsidian community plugins, Dataview, Templater, custom JavaScript, or custom CSS.

## Deployment status

Docker with SQLite/filesystem is the reference runtime. Railway uses the Docker profile with a volume declared in `.railway/railway.ts` and mounted at `/data`. AWS uses ECS/EFS or EC2/EBS; GCP uses a Compute Engine VM with Persistent Disk or Cloud Run with Filestore. Live storage is disk-only on every target: SQLite plus filesystem blobs on one volume per tenant. Object storage (S3/GCS/Railway bucket) holds periodic snapshot tarballs only, never live blobs. There are no PostgreSQL, S3-live, R2, D1, Vercel, or Cloudflare adapters.

## Mobile constraint

The Obsidian plugin must use Obsidian APIs, `requestUrl`, and Web Crypto only. Node filesystem, path, and crypto APIs are prohibited from the plugin runtime.
