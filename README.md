# <img src="tephra-website/public/logo-main.svg" alt="Tephra logo" height="36" align="absmiddle"> Tephra

Tephra is a self-hosted, web-based [Obsidian](https://obsidian.md) client. Your local vault stays the source of truth; Tephra syncs it to a server you run, so you can read and edit your notes from any browser. Wikilinks, backlinks, attachments, and the graph all work, and edits made on the web flow back into your vault.

> [!NOTE]
> Tephra is an independent project and is not officially affiliated with or endorsed by Obsidian.

It is built for one person on one box: a single container on your own domain, whether that's Railway, EC2, or any VM you control.

## Set up

1. **Deploy a server** (see below) and keep the `TEPHRA_BOOTSTRAP_TOKEN` you start it with.
2. **Create your account and a vault** in the web app, then create an upload token for that vault.
3. **Install the plugin** in Obsidian. The easiest route, on desktop and mobile, is [BRAT](docs/INSTALL_PLUGIN_BRAT.md), which installs it straight from this repo.
4. **Connect it:** paste the server URL, vault ID, and token into the plugin settings and click **Sync now**.

[Getting Started](docs/GETTING_STARTED.md) covers each step in detail.

## Deploy

<p>
  <a href="docs/deploy/RAILWAY.md"><img src="https://img.shields.io/badge/Deploy_to-Railway-853BCE?style=for-the-badge&logo=railway&logoColor=white" alt="Deploy to Railway" height="40"></a>
  <a href="https://shell.cloud.google.com/cloudshell/open?cloudshell_git_repo=https%3A%2F%2Fgithub.com%2Fchampionswimmer%2Ftephra.git&amp;cloudshell_workspace=.&amp;cloudshell_open_in_editor=docs%2Fdeploy%2FGCP.md"><img src="https://img.shields.io/badge/Deploy_to-GCP-4285F4?style=for-the-badge&logo=googlecloud&logoColor=white" alt="Deploy to GCP" height="40"></a>
  <a href="docs/deploy/AWS.md#one-click-cloudformation"><img src="https://img.shields.io/badge/Deploy_to-AWS-FF9900?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA0MCI%2BPHRleHQgeD0iMzIiIHk9IjIyIiBmb250LWZhbWlseT0iQXJpYWwsSGVsdmV0aWNhLHNhbnMtc2VyaWYiIGZvbnQtd2VpZ2h0PSI3MDAiIGZvbnQtc2l6ZT0iMjQiIGZpbGw9IiMyMzJGM0UiIHRleHQtYW5jaG9yPSJtaWRkbGUiPmF3czwvdGV4dD48cGF0aCBkPSJNMTAgMjljMTMgNyAzMSA3IDQ0IDAiIHN0cm9rZT0iIzIzMkYzRSIgc3Ryb2tlLXdpZHRoPSIzLjUiIGZpbGw9Im5vbmUiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPjxwYXRoIGQ9Ik00NyAyNGw4IDQtNiA2IiBzdHJva2U9IiMyMzJGM0UiIHN0cm9rZS13aWR0aD0iMy41IiBmaWxsPSJub25lIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiLz48L3N2Zz4%3D&logoColor=white" alt="Deploy to AWS" height="40"></a>
  <a href="docs/deploy/DO.md"><img src="https://img.shields.io/badge/Deploy_to-DigitalOcean-0080FF?style=for-the-badge&logo=digitalocean&logoColor=white" alt="Deploy to DigitalOcean" height="40"></a>
</p>

Each button opens a guide or a prefilled shell rather than deploying blindly: Tephra needs a persistent disk and exactly one instance, so one-click Cloud Run or App Platform buttons don't fit. See [`docs/deploy/`](docs/deploy/) for all guides.

## Good to know

- Notes are addressed by vault-relative path (`/#/path/to/note.md`), so links are shareable and behave the same on macOS, Linux, and Windows.
- A web edit creates a server revision that the plugin pulls into your vault. If a note changed in both places, the newest write wins and the other version is kept as a conflicted copy.
- The plugin remembers which note is which across renames using one of three [identity modes](tephra-plugin/README.md#behavior-and-privacy). The default sidecar mode never modifies your notes.
- Vaults are private, plugin tokens are scoped to one vault, blobs are SHA-256 verified, and Markdown is sanitized before display. See the [threat model](docs/THREAT_MODEL.md).

## Roadmap

A browser-safe subset of community plugin support, and optional publishing of chosen parts of a vault.

## Repository

- [`tephra-server/`](tephra-server/): API, web app, shared packages, deployment assets.
- [`tephra-plugin/`](tephra-plugin/): the mobile-compatible Obsidian sync plugin.
- [Stage 1 plan](.agents/plans/001-TEPHRA_STAGE1_PLAN.md)

## Development

Requires Node.js 22+ and npm 10+.

```bash
npm install
npm run check
npm run dev
```

The product READMEs cover configuration and usage.

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE).
