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

Docker with SQLite/filesystem is the reference runtime. Railway uses the Docker profile with a mounted volume. PostgreSQL, S3, R2, D1, Vercel, and Cloudflare directories preserve adapter boundaries or document future work; they are not assumed operational unless CI explicitly tests them.

## Mobile constraint

The Obsidian plugin must use Obsidian APIs, `requestUrl`, and Web Crypto only. Node filesystem, path, and crypto APIs are prohibited from the plugin runtime.
