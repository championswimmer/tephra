# Tephra Sync for Obsidian

Tephra Sync keeps your Obsidian vault and a Tephra Server vault in two-way sync. It supports desktop and mobile Obsidian: local changes are pushed up, and changes made on the server (web edits, other devices) are pulled down into your vault.

## Installation

### Via BRAT

The easiest way, including on mobile. See [Install with BRAT](../docs/INSTALL_PLUGIN_BRAT.md).

### Manual install

Download `main.js` and `manifest.json` from the [latest release](https://github.com/championswimmer/tephra/releases/latest), put them in `<vault>/.obsidian/plugins/tephra-sync/`, then enable **Tephra Sync** in Community plugins.

Contributors: build from source with `npm run build --workspace=@tephra/plugin`, or use the `sync-plugin` skill.

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
- Note identity (Settings → Note Identity) controls how Tephra remembers which note is which across renames: `Frontmatter property` writes a `tephra-file-id` into every note (most portable, but modifies notes and pollutes Properties/git diffs), `Sidecar file` (default, recommended) caches identities in `.tephra/data.json` (a gitignorable local cache — add `.tephra/` to `.gitignore` — never synced) without ever modifying notes and repairs from the server when needed, and `Path only` stores nothing (a rename looks like delete plus create: history restarts and old shared links stop working). Every switch starts with a dry-run preview (identities preserved/changed, notes rewritten, bytes to upload, links breaking) and requires explicit confirmation when any identity changes; any switch clears pending renames and queues a repair fetch for the next sync. The frontmatter write is the plugin's only vault write; its resulting modify event is suppressed. Use **Remove Tephra IDs from notes** (after switching to the sidecar, so identity is harvested first) to delete the property everywhere, or **Repair identities from server** to re-resolve from the server file list.
- Hidden paths (including `.obsidian` and `.tephra`) and common temporary files are excluded.
- Uploads are content-addressed. Only blobs reported missing by the server are sent, and a complete manifest is committed only after all uploads succeed.
- Offline and authentication failures do not advance local successful-sync state. Changes remain in the local vault and are retried later.
- Two-way sync (protocol v2, plugin 0.2.0+): every reconciliation pulls before it pushes. The plugin walks the server change feed from its persisted `lastPulledRevision` cursor (resuming across truncated pages), applies each entry by comparing blob hashes — never mtime — and only then scans, plans, uploads, and commits local changes. Downloads are hash-verified before anything is written.
- Conflict rule is last-write-wins with conflicted copies: if a note changed both locally and on the server since the last sync, the local file is left untouched and the server version is saved next to it as `<name> (server conflicted copy, YYYY-MM-DD).md` (attachments keep their extension). A server delete only removes the local file when it is still identical to the last-synced bytes; a locally edited file wins over the delete.
- If the pull cursor ever runs ahead of the server, the plugin falls back to the full-manifest repair; servers predating the change feed keep the previous full-reconcile behavior.

Prefer HTTPS whenever the server is not on a trusted local network. Tokens are never intentionally logged.
