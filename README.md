# Tephra

Tephra is a stripped-down, web-based Obsidian client that you host yourself. It keeps your local Obsidian vault as the source of truth, syncs it to a Tephra server, and lets you open that vault from any browser as if a lightweight copy of Obsidian were running on your own infrastructure.

Today, that means a private web mirror for your notes, links, attachments, and graph, with browser-based note editing and two-way sync so web edits flow back to your vault. In the future, Tephra aims to grow into a fuller cloud-hosted Obsidian companion with a safe subset of community plugin support and optional publishing controls.

Tephra is built for portable single-user deployments: run your vault on your own domain in one container or VM, whether that is an EC2 instance, a Railway deployment, or a similar box you control.

## Deploy

One private instance, your domain, one disk. Pick a platform (each guide is a few lines):

<p>
  <a href="docs/deploy/RAILWAY.md"><img src="https://railway.com/button.svg" alt="Deploy on Railway" height="40"></a>
  <a href="https://shell.cloud.google.com/cloudshell/open?cloudshell_git_repo=https%3A%2F%2Fgithub.com%2Fchampionswimmer%2Ftephra.git&amp;cloudshell_workspace=.&amp;cloudshell_open_in_editor=docs%2Fdeploy%2FGCP.md"><img src="https://gstatic.com/cloudssh/images/open-btn.svg" alt="Open in Google Cloud Shell" height="40"></a>
  <a href="docs/deploy/AWS.md#one-click-cloudformation"><img src="https://s3.amazonaws.com/cloudformation-examples/cloudformation-launch-stack.png" alt="Launch Stack on AWS" height="40"></a>
  <a href="docs/deploy/DO.md"><img src="https://www.deploytodo.com/do-btn-blue.svg" alt="Deploy to DigitalOcean" height="40"></a>
</p>

| Platform                           | What you get                                 | How                                             |
| ---------------------------------- | -------------------------------------------- | ----------------------------------------------- |
| [Railway](docs/deploy/RAILWAY.md)  | Service + volume, from `.railway/railway.ts` | `npm run deploy:railway`                        |
| [Google Cloud](docs/deploy/GCP.md) | VM + disk + static IP + Secret Manager       | Cloud Shell, then `scripts/deploy/gcp.sh`       |
| [AWS](docs/deploy/AWS.md)          | EC2 + encrypted EBS + Elastic IP             | CloudFormation stack or `scripts/deploy/aws.sh` |
| [DigitalOcean](docs/deploy/DO.md)  | Droplet + volume + Reserved IP               | `scripts/deploy/do.sh`                          |

The buttons open the guide or a prefilled shell, not a blind deploy: Tephra needs a persistent disk and exactly one instance, so the stock Cloud Run and App Platform one-click buttons do not fit.

## What Tephra does

- Mirrors your whole Obsidian vault into a private web app you can reach from anywhere.
- Preserves Obsidian-style reading features like rendered Markdown, wikilinks, backlinks, attachments, and graph navigation.
- Edits Markdown notes from the browser; each save creates a server revision that the Obsidian plugin pulls back into the local vault (last-write-wins with conflicted copies).
- Stays self-hosted and private: your domain, your login, your storage.
- Addresses every note by vault-relative path (`/#/path/to/note.md`): shareable links that survive identity changes and resolve identically across macOS, Linux, and Windows (NFC-canonicalized, case-sensitive with a unique-match fallback, rename-aware with a "moved from" hint).

## Note identity

The Obsidian plugin offers three identity modes (Settings → Note identity, default: sidecar file):

- **Frontmatter property** — writes a `tephra-file-id` into every note. Most portable, but modifies notes and shows up in Properties and git diffs.
- **Sidecar file (recommended)** — caches identities in `.tephra/data.json` (gitignorable cache, never synced) without touching notes; repairs from the server when needed.
- **Path only** — stores nothing; a rename looks like delete plus create, so history restarts and old links stop working.

Every mode switch starts with a dry-run preview and requires explicit confirmation when identities change. **Remove Tephra IDs from notes** (after switching to the sidecar, so identity is harvested first) deletes the property vault-wide.

## Where Tephra is headed

- A browser-safe subset of community plugin support.
- Optional publishing flows for chosen parts of a vault.

## Repository

- [`tephra-server/`](tephra-server/) — API, web application, shared domain packages, and deployment assets.
- [`tephra-plugin/`](tephra-plugin/) — mobile-compatible Obsidian synchronization plugin.
- [Stage 1 implementation plan](.agents/plans/001-TEPHRA_STAGE1_PLAN.md)

## Development

Requirements: Node.js 22+ and npm 10+.

```bash
npm install
npm run check
npm run dev
```

See the product READMEs for configuration and usage.

## Security model

Vaults are private. Plugin credentials are scoped to one vault. Uploaded blobs are independently SHA-256 verified. Markdown is treated as untrusted input and sanitized before display.

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE).
