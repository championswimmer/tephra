# End-to-end helpers

## Sync a local vault directory

`sync-vault.mjs` pushes a directory of Markdown/attachments to a running
Tephra server with the plugin sync protocol (plan → upload → commit), then
verifies every note renders and prints graph stats. It reuses the vault by
name, so re-runs only upload changed blobs.

```bash
# Terminal 1: API + web (from repo root)
PORT=8080 HOST=127.0.0.1 TEPHRA_BOOTSTRAP_TOKEN=... \
TEPHRA_SQLITE_PATH=./data/demo.db TEPHRA_BLOB_PATH=./data/demo-blobs \
node tephra-server/apps/api/dist/main.js

# Terminal 2: sync the sample vault
TEPHRA_BOOTSTRAP_TOKEN=... VAULT_DIR=sample-vault npm run sync:vault
```

Environment: `TEPHRA_BASE` (default `http://127.0.0.1:8080`),
`TEPHRA_ADMIN_EMAIL` / `TEPHRA_ADMIN_PASSWORD`
(default `admin@example.com` / `change-me-immediately`), `VAULT_NAME`
(default: directory basename), `DEVICE_ID` (default `e2e-harness`).
