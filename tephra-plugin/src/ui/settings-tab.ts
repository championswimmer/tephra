import { Notice, PluginSettingTab, Setting } from 'obsidian';
import type { App } from 'obsidian';
import { TephraClient } from '../api/client';
import type { RemoteVault } from '../api/client';
import type TephraPlugin from '../main';

export class TephraSettingTab extends PluginSettingTab {
  private loginEmail = '';
  private loginPassword = '';
  private newVaultName = '';
  private availableVaults: RemoteVault[] = [];
  private selectedVaultId = '';
  private isFetchingVaults = false;

  constructor(
    app: App,
    private readonly plugin: TephraPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    const currentStatus = this.plugin.status.get();
    containerEl.createEl('h2', { text: 'Tephra Cloud & Vault Control' });
    const statusDesc = containerEl.createEl('p', {
      cls: 'tephra-status-line',
      text: `Status: ${currentStatus.message}`,
    });
    statusDesc.style.color = 'var(--text-muted)';
    statusDesc.style.marginBottom = '1.5rem';

    this.renderServerSection(containerEl);
    this.renderAccountSection(containerEl);
    if (this.plugin.state.settings.auth) {
      this.renderVaultSection(containerEl);
    }
    this.renderSyncSection(containerEl);
    this.renderAdvancedSection(containerEl);
  }

  private renderServerSection(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Tephra Server' });

    new Setting(containerEl)
      .setName('Server URL')
      .setDesc('Base URL of your Tephra instance.')
      .addText((text) =>
        text
          .setPlaceholder('https://tephra.example.com')
          .setValue(this.plugin.state.settings.serverUrl)
          .onChange(async (value) => {
            this.plugin.state.settings.serverUrl = value.trim();
            await this.plugin.persistState();
          }),
      )
      .addButton((button) =>
        button.setButtonText('Test Connection').onClick(async () => {
          const url = this.plugin.state.settings.serverUrl.trim();
          if (!url) {
            new Notice('Please enter a server URL first.');
            return;
          }
          button.setDisabled(true);
          try {
            const client = new TephraClient(url);
            const res = await client.testConnection();
            if (res.ok) {
              new Notice('Connected to Tephra server successfully!');
            } else {
              new Notice(`Server returned status ${String(res.status)}.`);
            }
          } catch {
            new Notice('Unable to reach Tephra server.');
          } finally {
            button.setDisabled(false);
          }
        }),
      );
  }

  private renderAccountSection(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Account & Authentication' });
    const auth = this.plugin.state.settings.auth;

    if (auth?.sessionToken) {
      new Setting(containerEl)
        .setName('Active Session')
        .setDesc(`Logged in as ${auth.userEmail}`)
        .addButton((button) =>
          button
            .setButtonText('Log Out')
            .setWarning()
            .onClick(async () => {
              button.setDisabled(true);
              try {
                const client = new TephraClient(this.plugin.state.settings.serverUrl);
                await client.logout(auth.sessionToken);
              } catch {
                /* Clear local auth even if network logout failed */
              }
              delete this.plugin.state.settings.auth;
              await this.plugin.settingsChanged(false);
              new Notice('Logged out from Tephra.');
              this.display();
            }),
        );
    } else {
      new Setting(containerEl)
        .setName('Email / Username')
        .setDesc('Account email on your Tephra instance.')
        .addText((text) =>
          text
            .setPlaceholder('user@example.com')
            .setValue(this.loginEmail)
            .onChange((val) => {
              this.loginEmail = val.trim();
            }),
        );

      new Setting(containerEl)
        .setName('Password')
        .setDesc('Your Tephra account password.')
        .addText((text) => {
          text.inputEl.type = 'password';
          text
            .setPlaceholder('Password')
            .setValue(this.loginPassword)
            .onChange((val) => {
              this.loginPassword = val;
            });
        });

      new Setting(containerEl)
        .setName('Log In')
        .setDesc('Connect to your Tephra cloud account.')
        .addButton((button) =>
          button
            .setButtonText('Log In')
            .setCta()
            .onClick(async () => {
              const url = this.plugin.state.settings.serverUrl.trim();
              if (!url) {
                new Notice('Please configure Server URL first.');
                return;
              }
              if (!this.loginEmail || !this.loginPassword) {
                new Notice('Please provide both email and password.');
                return;
              }
              button.setDisabled(true);
              try {
                const client = new TephraClient(url);
                const res = await client.login(this.loginEmail, this.loginPassword);
                this.plugin.state.settings.auth = {
                  sessionToken: res.sessionToken,
                  userId: res.user.id,
                  userEmail: res.user.email,
                };
                this.loginPassword = '';
                await this.plugin.persistState();
                new Notice(`Welcome, ${res.user.email}!`);
                this.display();
              } catch (error) {
                const msg = error instanceof Error ? error.message : 'Login failed.';
                new Notice(`Login failed: ${msg}`);
              } finally {
                button.setDisabled(false);
              }
            }),
        );
    }
  }

  private renderVaultSection(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Remote Vault Control' });
    const { settings } = this.plugin.state;
    const auth = settings.auth;
    if (!auth) return;

    const boundDesc = settings.vaultId
      ? `Bound to: ${settings.vaultName || 'Vault'} (${settings.vaultId})`
      : 'No remote vault currently bound.';

    const activeSetting = new Setting(containerEl)
      .setName('Current Remote Vault')
      .setDesc(boundDesc);

    if (settings.vaultId && settings.serverUrl) {
      activeSetting.addButton((button) =>
        button.setButtonText('Open Web Mirror').onClick(() => {
          const base = settings.serverUrl.replace(/\/+$/, '');
          window.open(`${base}/vaults/${encodeURIComponent(settings.vaultId)}`, '_blank');
        }),
      );
    }

    // Bind existing vault
    const bindExisting = new Setting(containerEl)
      .setName('Link Existing Remote Vault')
      .setDesc('Select an existing vault on your Tephra cloud instance and automatically bind a token.');

    if (this.availableVaults.length > 0) {
      bindExisting.addDropdown((dropdown) => {
        dropdown.addOption('', '-- Select a vault --');
        for (const v of this.availableVaults) {
          dropdown.addOption(v.id, `${v.name} (rev ${String(v.latestRevision)})`);
        }
        dropdown.setValue(this.selectedVaultId);
        dropdown.onChange((val) => {
          this.selectedVaultId = val;
        });
      });
      bindExisting.addButton((button) =>
        button
          .setButtonText('Link Vault')
          .setCta()
          .onClick(async () => {
            if (!this.selectedVaultId) {
              new Notice('Please select a vault from the list.');
              return;
            }
            button.setDisabled(true);
            try {
              await this.provisionAndBindVault(this.selectedVaultId);
            } finally {
              button.setDisabled(false);
            }
          }),
      );
    } else {
      bindExisting.addButton((button) =>
        button
          .setButtonText(this.isFetchingVaults ? 'Fetching…' : 'Fetch Vaults')
          .setDisabled(this.isFetchingVaults)
          .onClick(async () => {
            this.isFetchingVaults = true;
            button.setDisabled(true);
            try {
              const client = new TephraClient(settings.serverUrl);
              this.availableVaults = await client.listVaults(auth.sessionToken);
              if (this.availableVaults.length === 0) {
                new Notice('No remote vaults found on this instance. Create one below!');
              }
              this.display();
            } catch (error) {
              const msg = error instanceof Error ? error.message : 'Failed to list vaults.';
              new Notice(`Failed to fetch vaults: ${msg}`);
            } finally {
              this.isFetchingVaults = false;
            }
          }),
      );
    }

    // Create new vault
    const defaultNewName = this.newVaultName || this.app.vault.getName() || 'Obsidian Vault';
    new Setting(containerEl)
      .setName('Create New Remote Vault')
      .setDesc('Provision a new vault on Tephra and bind this device immediately.')
      .addText((text) =>
        text
          .setPlaceholder(defaultNewName)
          .setValue(this.newVaultName)
          .onChange((val) => {
            this.newVaultName = val.trim();
          }),
      )
      .addButton((button) =>
        button
          .setButtonText('Create & Bind')
          .setCta()
          .onClick(async () => {
            const vaultName = this.newVaultName.trim() || defaultNewName;
            button.setDisabled(true);
            try {
              const client = new TephraClient(settings.serverUrl);
              const created = await client.createVault(vaultName, auth.sessionToken);
              this.plugin.state.settings.vaultName = created.name;
              await this.provisionAndBindVault(created.id, created.name);
            } catch (error) {
              const msg = error instanceof Error ? error.message : 'Failed to create vault.';
              new Notice(`Failed to create vault: ${msg}`);
            } finally {
              button.setDisabled(false);
            }
          }),
      );
  }

  private async provisionAndBindVault(vaultId: string, vaultName?: string): Promise<void> {
    const { settings } = this.plugin.state;
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
      this.availableVaults.find((v) => v.id === vaultId)?.name ??
      vaultId;

    this.plugin.state.settings.vaultId = vaultId;
    this.plugin.state.settings.vaultName = name;
    this.plugin.state.settings.uploadToken = tokenResult.value;

    await this.plugin.settingsChanged(this.plugin.state.settings.enableSync);
    new Notice(`Bound device to vault "${name}".`);
    this.display();
  }

  private renderSyncSection(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Vault Synchronization' });

    new Setting(containerEl)
      .setName('Enable Direct Sync')
      .setDesc(
        'Upload local notes and attachments directly to Tephra. Turn this off if your vault is synchronized via the Obsidian Sync sidecar or another service to prevent duplicate work.',
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.state.settings.enableSync)
          .onChange(async (val) => {
            this.plugin.state.settings.enableSync = val;
            await this.plugin.settingsChanged(val);
            this.display();
          }),
      );

    if (this.plugin.state.settings.enableSync) {
      new Setting(containerEl)
        .setName('Manual Sync')
        .setDesc('Reconcile local changes with the remote vault immediately.')
        .addButton((button) =>
          button
            .setButtonText('Sync now')
            .setCta()
            .onClick(() => void this.plugin.syncNow(true)),
        );

      if (this.plugin.state.lastSuccessfulSyncAt) {
        containerEl.createEl('p', {
          text: `Last successful sync: ${new Date(this.plugin.state.lastSuccessfulSyncAt).toLocaleString()} (revision ${String(this.plugin.state.lastRemoteRevision ?? 0)})`,
        });
      }

      new Setting(containerEl)
        .setName('Debounce (milliseconds)')
        .setDesc('Wait period after file modifications before triggering sync.')
        .addText((text) =>
          text.setValue(String(this.plugin.state.settings.debounceMs)).onChange(async (value) => {
            const parsed = Number(value);
            if (Number.isFinite(parsed) && parsed >= 250 && parsed <= 60_000) {
              this.plugin.state.settings.debounceMs = Math.floor(parsed);
              await this.plugin.settingsChanged(false);
            }
          }),
        );

      new Setting(containerEl)
        .setName('Upload Concurrency')
        .setDesc('Maximum simultaneous blob uploads (1 - 10).')
        .addText((text) =>
          text.setValue(String(this.plugin.state.settings.concurrency)).onChange(async (value) => {
            const parsed = Number(value);
            if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 10) {
              this.plugin.state.settings.concurrency = parsed;
              await this.plugin.settingsChanged(false);
            }
          }),
        );
    } else {
      const callout = containerEl.createEl('div', { cls: 'tephra-callout' });
      callout.style.padding = '0.75rem 1rem';
      callout.style.marginBottom = '1rem';
      callout.style.borderRadius = '6px';
      callout.style.backgroundColor = 'var(--background-secondary)';
      callout.createEl('p', {
        text: 'Direct sync is paused. Your vault can still be synchronized via the headless Obsidian Sync sidecar or external tools while this plugin manages your Tephra instance.',
      });
    }

    new Setting(containerEl)
      .setName('Remove Tephra IDs from notes')
      .setDesc(
        'Delete the tephra-file-id property from every note in the vault. This rewrites files and cannot be undone by Tephra — back up first.',
      )
      .addButton((button) =>
        button
          .setButtonText('Remove file IDs…')
          .setWarning()
          .onClick(() => void this.plugin.removeFileIdsFromAllNotes()),
      );
  }

  private renderAdvancedSection(containerEl: HTMLElement): void {
    const details = containerEl.createEl('details');
    details.style.marginTop = '1.5rem';
    details.style.padding = '0.5rem 0';
    details.createEl('summary', { text: 'Advanced Settings & Device Overrides' });

    const content = details.createEl('div');
    content.style.marginTop = '0.75rem';

    new Setting(content)
      .setName('Device ID')
      .setDesc('Unique identifier for this installation.')
      .addText((text) => {
        text.setValue(this.plugin.state.settings.deviceId).setDisabled(true);
      });

    new Setting(content)
      .setName('Device Name')
      .setDesc('Friendly device name sent to Tephra.')
      .addText((text) =>
        text.setValue(this.plugin.state.settings.deviceName).onChange(async (value) => {
          this.plugin.state.settings.deviceName = value.trim() || 'Obsidian';
          await this.plugin.persistState();
        }),
      );

    new Setting(content)
      .setName('Manual Vault ID')
      .setDesc('Override vault identifier directly.')
      .addText((text) =>
        text.setValue(this.plugin.state.settings.vaultId).onChange(async (value) => {
          this.plugin.state.settings.vaultId = value.trim();
          await this.plugin.settingsChanged(false);
        }),
      );

    new Setting(content)
      .setName('Manual Upload Token')
      .setDesc('Override upload token directly.')
      .addText((text) => {
        text.inputEl.type = 'password';
        text
          .setPlaceholder('Vault-scoped token')
          .setValue(this.plugin.state.settings.uploadToken)
          .onChange(async (value) => {
            this.plugin.state.settings.uploadToken = value;
            await this.plugin.settingsChanged(false);
          });
      });
  }
}
