import { Notice, Setting } from 'obsidian';
import { TephraClient } from '../../api/client';
import type { SettingsContext } from './context';

export function renderVaultSection(ctx: SettingsContext, containerEl: HTMLElement): void {
  const { app, plugin, form, refresh } = ctx;
  containerEl.createEl('h3', { text: 'Remote Vault Control' });
  const { settings } = plugin.state;
  const auth = settings.auth;
  if (!auth) return;

  const boundDesc = settings.vaultId
    ? `Bound to: ${settings.vaultName || 'Vault'} (${settings.vaultId})`
    : 'No remote vault currently bound.';

  const activeSetting = new Setting(containerEl)
    .setName('Current Remote Vault')
    .setDesc(boundDesc);

  if ((settings.vaultId || settings.vaultName) && settings.serverUrl) {
    activeSetting.addButton((button) =>
      button.setButtonText('Open Web Mirror').onClick(() => {
        const base = settings.serverUrl.replace(/\/+$/, '');
        // Web URLs are addressed by the globally-unique vault name;
        // the workspace also resolves a stale id, so open synchronously
        // and refresh the cached name in the background for next time.
        const slug = settings.vaultName || settings.vaultId;
        window.open(`${base}/v/${encodeURIComponent(slug)}`, '_blank');
        void refreshBoundVaultName(ctx);
      }),
    );
  }

  // Bind existing vault
  const bindExisting = new Setting(containerEl)
    .setName('Link Existing Remote Vault')
    .setDesc('Select an existing vault on your Tephra cloud instance and automatically bind a token.');

  if (form.availableVaults.length > 0) {
    bindExisting.addDropdown((dropdown) => {
      dropdown.addOption('', '-- Select a vault --');
      for (const v of form.availableVaults) {
        dropdown.addOption(v.id, `${v.name} (rev ${String(v.latestRevision)})`);
      }
      dropdown.setValue(form.selectedVaultId);
      dropdown.onChange((val) => {
        form.selectedVaultId = val;
      });
    });
    bindExisting.addButton((button) =>
      button
        .setButtonText('Link Vault')
        .setCta()
        .onClick(async () => {
          if (!form.selectedVaultId) {
            new Notice('Please select a vault from the list.');
            return;
          }
          button.setDisabled(true);
          try {
            await provisionAndBindVault(ctx, form.selectedVaultId);
          } catch (error) {
            const msg = error instanceof Error ? error.message : 'Failed to link vault.';
            new Notice(`Failed to link vault: ${msg}`);
          } finally {
            button.setDisabled(false);
          }
        }),
    );
  } else {
    bindExisting.addButton((button) =>
      button
        .setButtonText(form.isFetchingVaults ? 'Fetching…' : 'Fetch Vaults')
        .setDisabled(form.isFetchingVaults)
        .onClick(async () => {
          form.isFetchingVaults = true;
          button.setDisabled(true);
          try {
            const client = new TephraClient(settings.serverUrl);
            form.availableVaults = await client.listVaults(auth.sessionToken);
            if (form.availableVaults.length === 0) {
              new Notice('No remote vaults found on this instance. Create one below!');
            }
            refresh();
          } catch (error) {
            const msg = error instanceof Error ? error.message : 'Failed to list vaults.';
            new Notice(`Failed to fetch vaults: ${msg}`);
          } finally {
            form.isFetchingVaults = false;
          }
        }),
    );
  }

  // Create new vault
  const defaultNewName = form.newVaultName || app.vault.getName() || 'Obsidian Vault';
  new Setting(containerEl)
    .setName('Create New Remote Vault')
    .setDesc('Provision a new vault on Tephra and bind this device immediately.')
    .addText((text) =>
      text
        .setPlaceholder(defaultNewName)
        .setValue(form.newVaultName)
        .onChange((val) => {
          form.newVaultName = val.trim();
        }),
    )
    .addButton((button) =>
      button
        .setButtonText('Create & Bind')
        .setCta()
        .onClick(async () => {
          const vaultName = form.newVaultName.trim() || defaultNewName;
          button.setDisabled(true);
          try {
            const client = new TephraClient(settings.serverUrl);
            const created = await client.createVault(vaultName, auth.sessionToken);
            plugin.state.settings.vaultName = created.name;
            await provisionAndBindVault(ctx, created.id, created.name);
          } catch (error) {
            const msg = error instanceof Error ? error.message : 'Failed to create vault.';
            new Notice(`Failed to create vault: ${msg}`);
          } finally {
            button.setDisabled(false);
          }
        }),
    );
}

/**
 * Best-effort refresh of the cached vault name (vault-name URLs): keeps
 * "Open Web Mirror" on the canonical `/v/<name>` slug across
 * server-side renames. Silent — the next sync canonicalizes anyway.
 */
async function refreshBoundVaultName(ctx: SettingsContext): Promise<void> {
  const { plugin } = ctx;
  const { settings } = plugin.state;
  const slug = settings.vaultId || settings.vaultName || '';
  const token = settings.auth?.sessionToken || settings.uploadToken || undefined;
  if (!settings.serverUrl || !slug || !token) return;
  try {
    const client = new TephraClient(settings.serverUrl);
    const vault = await client.getVault(slug, token);
    if (vault.id !== settings.vaultId || vault.name !== settings.vaultName) {
      settings.vaultId = vault.id;
      settings.vaultName = vault.name;
      await plugin.persistState();
    }
  } catch {
    // Keep the stored slug; the workspace resolves id-or-name too.
  }
}

async function provisionAndBindVault(ctx: SettingsContext, vaultId: string, vaultName?: string): Promise<void> {
  const { plugin, form, refresh } = ctx;
  const { settings } = plugin.state;
  const auth = settings.auth;
  if (!auth) return;

  const client = new TephraClient(settings.serverUrl);
  const tokenName = `Obsidian (${settings.deviceName || 'Device'})`;
  const tokenResult = await client.provisionVaultToken(
    vaultId,
    {
      name: tokenName,
      deviceId: settings.deviceId,
      deviceName: settings.deviceName,
      platform: 'obsidian-plugin',
    },
    auth.sessionToken,
  );

  const name =
    vaultName ??
    form.availableVaults.find((v) => v.id === vaultId)?.name ??
    vaultId;

  plugin.state.settings.vaultId = vaultId;
  plugin.state.settings.vaultName = name;
  plugin.state.settings.uploadToken = tokenResult.value;

  await plugin.settingsChanged(plugin.state.settings.enableSync);
  new Notice(`Bound device to vault "${name}".`);
  refresh();
}
