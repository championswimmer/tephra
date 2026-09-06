---
name: sync-plugin
description: Build and install/sync the latest Tephra Obsidian plugin (main.js, manifest.json) into local Obsidian vaults. Use whenever plugin code has changed or the user asks to sync, update, or install the plugin in their Obsidian app.
---

# Tephra Obsidian Plugin Sync

Builds the latest `@tephra/plugin` bundle and copies the distribution files (`main.js`, `manifest.json`, and `styles.css` if present) directly into the target Obsidian vault's `.obsidian/plugins/tephra-sync/` directory. Existing configuration and tokens in `data.json` are preserved.

## Quick Sync

From the repository root:

```bash
npm run sync:plugin
```

This will:

1. Run `npm run build` in `tephra-plugin` to generate fresh `main.js`.
2. Auto-detect your active Obsidian vault (via `obsidian.json` or `OBSIDIAN_VAULT_PATH`).
3. Copy `main.js` and `manifest.json` to `<vault>/.obsidian/plugins/tephra-sync/`.
4. Preserve existing plugin configuration and token state (`data.json`).

## Usage & Options

You can also run the script directly with options:

```bash
# Sync to an explicit vault path
node scripts/sync-plugin.mjs /Users/username/Obsidian/MyVault

# Sync to all configured Obsidian vaults
npm run sync:plugin -- --all

# Skip the build step (if already built)
node scripts/sync-plugin.mjs --no-build

# Set custom vault path via environment variable
OBSIDIAN_VAULT_PATH=~/Obsidian/Main npm run sync:plugin
```

## Reloading the Plugin in Obsidian

After syncing, update the running Obsidian app without restarting:

1. **Option 1 (Fastest)**: In Obsidian, press **Cmd + R** (macOS) or **Ctrl + R** (Windows/Linux) / run Command Palette: `Reload app without saving`.
2. **Option 2**: Go to **Settings** -> **Community Plugins**, toggle **Tephra Sync** off, and toggle it back on.
3. **Option 3**: If using a hot-reload plugin, it will detect the timestamp update on `main.js` automatically.

## Vault Detection Logic

The script locates vaults automatically:

- **macOS**: `~/Library/Application Support/obsidian/obsidian.json`
- **Linux**: `~/.config/obsidian/obsidian.json`
- **Windows**: `%APPDATA%/obsidian/obsidian.json`
- **Fallbacks**: `~/Obsidian/Main` and `~/Documents/Obsidian Vault`
