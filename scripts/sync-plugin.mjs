#!/usr/bin/env node

/**
 * Builds the Tephra Obsidian plugin and copies the bundle (main.js, manifest.json)
 * into target Obsidian vault(s) under .obsidian/plugins/tephra-sync.
 *
 * Usage:
 *   node scripts/sync-plugin.mjs
 *   node scripts/sync-plugin.mjs /path/to/Obsidian/Vault
 *   node scripts/sync-plugin.mjs --all
 *   node scripts/sync-plugin.mjs --no-build
 */

import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, utimesSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const PLUGIN_SRC_DIR = path.join(REPO_ROOT, 'tephra-plugin');

function getArgs() {
  const args = process.argv.slice(2);
  let skipBuild = false;
  let allVaults = false;
  const explicitVaults = [];

  for (const arg of args) {
    if (arg === '--no-build') {
      skipBuild = true;
    } else if (arg === '--all') {
      allVaults = true;
    } else if (arg.startsWith('--vault=')) {
      explicitVaults.push(arg.slice('--vault='.length));
    } else if (!arg.startsWith('--')) {
      explicitVaults.push(arg);
    }
  }

  return { skipBuild, allVaults, explicitVaults };
}

function getObsidianConfigFile() {
  const platform = os.platform();
  const home = os.homedir();
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'obsidian', 'obsidian.json');
  }
  if (platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'obsidian', 'obsidian.json');
  }
  // Linux / other
  return path.join(home, '.config', 'obsidian', 'obsidian.json');
}

function discoverVaults() {
  const vaults = new Map(); // path -> { open: boolean, ts: number }

  const envVault = process.env.OBSIDIAN_VAULT_PATH;
  if (envVault && existsSync(envVault)) {
    vaults.set(path.resolve(envVault), { open: true, ts: Date.now() });
  }

  const configFile = getObsidianConfigFile();
  if (existsSync(configFile)) {
    try {
      const parsed = JSON.parse(readFileSync(configFile, 'utf8'));
      if (parsed?.vaults && typeof parsed.vaults === 'object') {
        for (const meta of Object.values(parsed.vaults)) {
          if (meta?.path && existsSync(meta.path)) {
            vaults.set(path.resolve(meta.path), {
              open: Boolean(meta.open),
              ts: Number(meta.ts) || 0,
            });
          }
        }
      }
    } catch {
      // Ignore config read error
    }
  }

  // Fallback checks
  const fallbackPaths = [
    path.join(os.homedir(), 'Obsidian', 'Main'),
    path.join(os.homedir(), 'Documents', 'Obsidian Vault'),
  ];
  for (const fallback of fallbackPaths) {
    if (existsSync(fallback) && !vaults.has(path.resolve(fallback))) {
      vaults.set(path.resolve(fallback), { open: false, ts: 0 });
    }
  }

  return vaults;
}

function buildPlugin() {
  console.log('📦 Building Tephra Obsidian plugin...');
  execSync('npm run build', {
    cwd: PLUGIN_SRC_DIR,
    stdio: 'inherit',
  });
  console.log('✅ Plugin build complete.\n');
}

function syncToVault(vaultPath) {
  const pluginDestDir = path.join(vaultPath, '.obsidian', 'plugins', 'tephra-sync');
  mkdirSync(pluginDestDir, { recursive: true });

  const filesToCopy = ['main.js', 'manifest.json', 'styles.css'];
  let copiedCount = 0;

  for (const file of filesToCopy) {
    const src = path.join(PLUGIN_SRC_DIR, file);
    const dest = path.join(pluginDestDir, file);
    if (existsSync(src)) {
      copyFileSync(src, dest);
      copiedCount += 1;
    }
  }

  // Touch main.js to notify hot reload if installed
  const destMain = path.join(pluginDestDir, 'main.js');
  if (existsSync(destMain)) {
    const now = new Date();
    try {
      utimesSync(destMain, now, now);
    } catch {
      // Non-critical
    }
  }

  console.log(`✨ Synced ${copiedCount} file(s) to:\n   ${pluginDestDir}`);
}

async function main() {
  const { skipBuild, allVaults, explicitVaults } = getArgs();

  if (!skipBuild) {
    buildPlugin();
  }

  let targetVaults = [];

  if (explicitVaults.length > 0) {
    targetVaults = explicitVaults.map((v) => path.resolve(v));
  } else {
    const discovered = discoverVaults();
    if (discovered.size === 0) {
      console.error('❌ Could not auto-detect any Obsidian vaults.');
      console.error('Please specify your vault path: node scripts/sync-plugin.mjs /path/to/vault');
      process.exit(1);
    }

    if (allVaults) {
      targetVaults = Array.from(discovered.keys());
    } else {
      // Pick open vaults, or the most recently opened vault
      const openVaults = Array.from(discovered.entries())
        .filter(([, meta]) => meta.open)
        .map(([vaultPath]) => vaultPath);

      if (openVaults.length > 0) {
        targetVaults = openVaults;
      } else {
        // Most recently used
        const sorted = Array.from(discovered.entries()).sort(([, a], [, b]) => b.ts - a.ts);
        targetVaults = [sorted[0][0]];
      }
    }
  }

  for (const vault of targetVaults) {
    if (!existsSync(vault)) {
      console.warn(`⚠️  Vault path does not exist, skipping: ${vault}`);
      continue;
    }
    syncToVault(vault);
  }

  console.log('\n💡 To reload in Obsidian:');
  console.log('   - Press Cmd + R (or run Command Palette: "Reload app without saving")');
  console.log('   - Or toggle "Tephra Sync" off and on in Settings -> Community Plugins.\n');
}

main().catch((err) => {
  console.error('Failed to sync plugin:', err);
  process.exit(1);
});
