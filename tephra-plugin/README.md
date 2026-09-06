# Tephra Sync for Obsidian

Tephra Sync creates a one-way, read-only web mirror of your Obsidian vault on a Tephra Server. It supports desktop and mobile Obsidian and never downloads or applies server content to your vault.

## Installation

### Via BRAT (Beta Reviewer's Auto-update Tool)

To install beta releases directly within Obsidian, you can use the [Obsidian42 - BRAT](https://github.com/TfTHacker/obsidian42-brat) community plugin:

1. **Install BRAT**:
   - In Obsidian, go to **Settings → Community plugins**.
   - Turn off **Restricted mode** if it is enabled.
   - Click **Browse**, search for **Obsidian42 - BRAT**, click **Install**, and then **Enable**.
2. **Add Tephra Sync to BRAT**:
   - Open **Settings → BRAT** (or run the command `BRAT: Plugins: Add a beta plugin for testing` from the Command Palette `Ctrl/Cmd + P`).
   - Under **Beta Plugin List**, click **Add Beta plugin**.
   - Enter the repository URL: `https://github.com/championswimmer/tephra` (or shorthand `championswimmer/tephra`).
   - Click **Add Plugin**. BRAT will download the latest release files into your vault's plugin directory.
3. **Enable Tephra Sync**:
   - Go to **Settings → Community plugins**.
   - Under **Installed plugins**, find **Tephra Sync** and toggle it **on**.

BRAT will automatically check for updates and keep the plugin up to date when new releases are published.

### Install from source

From the repository root, install workspace dependencies and run:

```sh
npm run build --workspace=@tephra/plugin
```

Copy `main.js`, `manifest.json`, and `versions.json` into `<vault>/.obsidian/plugins/tephra-sync/`, then enable **Tephra Sync** in Community plugins.

## Configure

In **Settings → Tephra Sync**, enter:

- the Tephra Server base URL;
- the remote vault ID;
- a vault-scoped upload token;
- a device name;
- optional debounce and upload concurrency values.

A device ID is generated automatically. The token and sync metadata are stored in Obsidian's plugin data and the token field is password-masked. Protect the vault and device backups accordingly.

Use **Sync now** in settings or the command palette for a manual full reconciliation. The status bar reports progress and the latest revision. Tephra also reconciles after startup, local file events, settings changes, and every ten minutes.

## Behavior and privacy

- Original Markdown and attachment bytes are uploaded over HTTP(S) to the configured server.
- Markdown notes receive a `tephra-file-id` frontmatter property to preserve identity across renames. This is the plugin's only vault write; its resulting modify event is suppressed.
- Attachment identities are retained in plugin data by path and are preserved for Obsidian rename events.
- Hidden paths (including `.obsidian`) and common temporary files are excluded.
- Uploads are content-addressed. Only blobs reported missing by the server are sent, and a complete manifest is committed only after all uploads succeed.
- Offline and authentication failures do not advance local successful-sync state. Changes remain in the local vault and are retried later.
- Stage 1 is upload-only: server content is never written into the vault and no web edits are downloaded.

Prefer HTTPS whenever the server is not on a trusted local network. Tokens are never intentionally logged.
