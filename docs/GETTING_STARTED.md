# Getting Started: Sync Your Obsidian Vault to Your Tephra Server

This guide walks you from a freshly hosted Tephra server on your personal VPS
to a working Obsidian sync. By the end, your vault will be mirrored as a
private, read-only website you can browse from any browser.

**What you need before starting**

- Your Tephra server running and reachable at a URL you control
  (for example `https://tephra.example.com`). If you have not deployed yet,
  see `tephra-server/README.md` (Docker section) for the single-container setup.
- The `TEPHRA_BOOTSTRAP_TOKEN` value you started the server with
  (only needed once, to create the first admin account).
- Obsidian (desktop or mobile) with the vault you want to mirror.
- About 10 minutes.

**How the pieces fit together**

1. You create an admin account in the browser (one-time bootstrap).
2. You create a **vault** in the Tephra web UI — this is the server-side
   mirror destination, not your local Obsidian folder.
3. You create an **upload token** for that vault (scoped to that vault only).
4. You install the **Tephra Sync** plugin in Obsidian and paste in the
   server URL, vault ID, and token.
5. The plugin uploads your notes and attachments. The web UI becomes your
   read-only mirror.

> Stage 1 is upload-only: the server never writes back into your Obsidian
> vault. Your local vault stays the source of truth.

---

## Step 1 — Open your server and create the admin account

1. In a browser, open your server URL (for example `https://tephra.example.com`).
2. Because no users exist yet, Tephra shows the **bootstrap page**.
3. Enter your `TEPHRA_BOOTSTRAP_TOKEN` and choose an admin username and password.
4. Confirm you can log in.

**Then lock the ladder behind you:** remove `TEPHRA_BOOTSTRAP_TOKEN` from the
server's environment and restart the container. The bootstrap endpoint stops
working permanently once a user exists, and the token must never be reused as
a password or pasted into the Obsidian plugin.

```bash
# On your VPS: unset the bootstrap token and restart
docker stop tephra
# remove or blank TEPHRA_BOOTSTRAP_TOKEN from your env file / compose env
docker start tephra
```

---

## Step 2 — Create a vault in the web UI

1. Log in at your server URL.
2. On the **Your vaults** page, type a name (for example `My Notes`) into the
   **New vault name** field and click **Create vault**.
3. Click the new vault to open it. It will be empty — that is expected.

**Find your vault ID:** once the vault is open, look at the browser address bar.
The URL looks like `https://tephra.example.com/v/<vault-id>` — the part after
`/v/` is your **vault ID**. Copy it; you will paste it into Obsidian in Step 4.

---

## Step 3 — Create an upload token for the vault

1. Inside your vault, click the **Tokens** tab (top-right navigation).
2. Under **Upload tokens**, enter a name that identifies the device, for example
   `Laptop` or `Phone`, and click **Create token**.
3. A token string appears under **Copy this token now**. Copy it immediately —
   **it is shown only once** and cannot be recovered later.

Notes:

- One token per device is recommended, so you can revoke a lost device without
  affecting the others.
- A token works only for the vault it was created in.
- If you lose a token, revoke it in the same Tokens tab and create a fresh one.

---

## Step 4 — Install the Tephra Sync plugin in Obsidian

The plugin is not yet in the Obsidian community store, so install it manually:

1. On a machine with the Tephra repository, build the plugin:
   ```sh
   npm run build --workspace=@tephra/plugin
   ```
2. Copy `main.js`, `manifest.json`, and `versions.json` from `tephra-plugin/`
   into your vault's plugin folder:
   `<vault>/.obsidian/plugins/tephra-sync/`
   (for mobile, use a file manager or sync tool to place the same three files
   in the same path inside your mobile vault folder).
3. In Obsidian, open **Settings → Community plugins**, enable **Tephra Sync**.
   (You must have community plugins enabled.)

---

## Step 5 — Connect the plugin to your server

1. Open **Settings → Tephra Sync**.
2. Fill in:
   - **Server URL** — your server's base URL, exactly as you browse it
     (for example `https://tephra.example.com`, no trailing slash needed).
     Use HTTPS for anything outside your home network.
   - **Vault ID** — the ID you copied from the browser address bar in Step 2.
   - **Upload token** — the token you copied in Step 3.
   - **Device name** — a friendly label for this device (for example `Laptop`).
3. Leave **Debounce** (default 2000 ms) and **Upload concurrency** (default 3)
   alone unless you know you need to change them.
4. Click **Sync now**.

The status bar reports progress and the latest synced revision. On a first sync
of a large vault this can take a few minutes; attachments upload as
content-addressed blobs and only missing blobs are sent.

> Never paste your `TEPHRA_BOOTSTRAP_TOKEN` into the plugin. The plugin only
> ever needs the vault-scoped upload token from Step 3.

---

## Step 6 — Verify the mirror in your browser

1. Go back to your vault in the Tephra web UI and refresh.
2. Browse the file tree, open a note, and check that wikilinks resolve.
3. Open the **Graph** view to confirm links were indexed.
4. In Obsidian settings, confirm **Last successful sync** shows the current
   time and revision number.

If the vault still shows empty, see Troubleshooting below.

---

## Daily use

- **Normal edits just sync.** The plugin also reconciles automatically after
  startup, on local file changes, on settings changes, and every ten minutes.
- **Renames are safe.** The plugin tags Markdown notes with a `tephra-file-id`
  frontmatter property to preserve identity across renames — this is its only
  write to your vault, and it is harmless.
- **Syncing a second device (e.g. your phone):** create a second token in the
  Tokens tab (Step 3), install the plugin in mobile Obsidian (Step 4), and
  enter the same server URL and vault ID with the new token (Step 5). Both
  devices mirror into the same server-side vault.
- **Revoking access:** open the Tokens tab, click **Revoke** next to the lost
  or retired device's token.
- **Backups:** your Obsidian folder is still the source of truth — keep
  backing it up as before. For the server side, back up the whole `/data`
  volume; see "Persistence and backup" in `tephra-server/README.md`.

---

## Troubleshooting

| Symptom | Likely cause and fix |
| --- | --- |
| Plugin reports an authentication error | Wrong token or vault ID. Re-copy the vault ID from the `/v/` URL and create a fresh token (tokens display only once). Make sure you did not paste the bootstrap token. |
| Connection / network error | Server URL typo, server down, or TLS issue. `curl --fail https://your-server/healthz` from another machine to check reachability. Re-check reverse-proxy and firewall on the VPS. |
| Sync succeeds but web vault is empty | You may be looking at a different vault — match the vault ID in the URL with the one in plugin settings. Otherwise wait for indexing to finish and refresh. |
| Some attachments missing | Retry **Sync now**; interrupted uploads resume on the next run. Very large files may exceed `TEPHRA_MAX_BLOB_BYTES` (default 100 MiB) — check server logs. |
| Bootstrap page does not appear | A user already exists (just log in) or the server was started without `TEPHRA_BOOTSTRAP_TOKEN`. Check the container env and restart with the token set. |
| "Last successful sync" never updates | Offline or auth failure — local state is intentionally not advanced. Fix the underlying error; pending changes are retried automatically. |

If problems persist, check the server logs for request errors (tokens and note
contents are never logged) and verify `/healthz` and `/readyz` respond.

---

## Quick reference

- Server health: `https://your-server/healthz` · readiness: `/readyz`
- Vault ID: the part of the web URL after `/v/`
- Tokens tab: `/v/<vault-id>/tokens` — create one token per device
- Plugin settings: server URL, vault ID, upload token, device name, **Sync now**
- Security: HTTPS in production, `TEPHRA_ALLOW_SIGNUPS=false`, bootstrap token
  removed after first setup
