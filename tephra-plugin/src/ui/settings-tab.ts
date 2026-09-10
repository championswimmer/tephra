import { Notice, PluginSettingTab, Setting } from 'obsidian';
import type { App } from 'obsidian';
import { TephraClient } from '../api/client';
import type { RemoteVault } from '../api/client';
import type TephraPlugin from '../main';
import type { IdentityMode } from '../state/plugin-state';
import { IdentityMigrationModal } from './identity-migration-modal';

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
    this.renderIdentitySection(containerEl);
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
          // Web URLs are addressed by the globally-unique vault name.
          const slug = settings.vaultName || settings.vaultId;
          window.open(`${base}/v/${encodeURIComponent(slug)}`, '_blank');
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

  /**
   * Note-identity mode selection (plan 010, §11.1). Rendered only when
   * direct sync is on. Switching never happens silently: the dropdown picks
   * a target mode and Preview changes always dry-runs first.
   */
  private renderIdentitySection(containerEl: HTMLElement): void {
    if (!this.plugin.state.settings.enableSync) return;
    containerEl.createEl('h3', { text: 'Note Identity' });

    const current = this.plugin.state.settings.identityMode;
    const help: Record<IdentityMode, string> = {
      frontmatter:
        'Most portable. Tephra writes a `tephra-file-id` property into every note. ' +
        'Renames and multi-device setups always keep the same identity — but your notes are ' +
        'modified, the property appears in Obsidian Properties, and it shows up in git diffs.',
      sidecar:
        'Tephra never modifies your notes. Identities are cached in `.tephra/data.json` and ' +
        'repaired from your Tephra server when needed. Renames are preserved. A note renamed ' +
        '*and* edited while Obsidian was closed may get a new identity.',
      path:
        "Nothing is stored. A note's identity is its path. Renaming a note looks like deleting " +
        'and re-creating it: its history restarts and previously shared links to the old path ' +
        'stop working. Best for a single device that rarely renames.',
    };
    let selected: IdentityMode = current;

    new Setting(containerEl)
      .setName('Note identity')
      .setDesc('How Tephra remembers which note is which across renames.')
      .addDropdown((dropdown) => {
        dropdown.addOption('frontmatter', 'Frontmatter property');
        dropdown.addOption('sidecar', 'Sidecar file (recommended)');
        dropdown.addOption('path', 'Path only');
        dropdown.setValue(current);
        dropdown.onChange((value) => {
          selected = value as IdentityMode;
          helpEl.setText(help[selected]);
          hintEl.setText(
            selected === this.plugin.state.settings.identityMode
              ? `Currently active: ${selected}.`
              : `Currently active: ${this.plugin.state.settings.identityMode}. Preview and confirm to switch to ${selected}.`,
          );
        });
      });

    const helpEl = containerEl.createEl('p', { text: help[current] });
    helpEl.style.color = 'var(--text-muted)';
    const hintEl = containerEl.createEl('p', { text: `Currently active: ${current}.` });
    hintEl.style.color = 'var(--text-muted)';

    new Setting(containerEl)
      .setName('Preview changes')
      .setDesc('Dry-run a mode switch before anything is rewritten.')
      .addButton((button) =>
        button.setButtonText('Preview changes…').onClick(() => void this.previewMigration(selected)),
      );

    new Setting(containerEl)
      .setName('Repair identities from server')
      .setDesc('Re-fetch the server file list and re-resolve local identities.')
      .addButton((button) =>
        button.setButtonText('Repair now').onClick(async () => {
          button.setDisabled(true);
          try {
            await this.plugin.repairIdentitiesFromServer();
            new Notice('Tephra: identity repair requested.');
          } catch {
            new Notice('Tephra: identity repair failed — see settings status.');
          } finally {
            button.setDisabled(false);
            this.display();
          }
        }),
      );

    const pending = this.plugin.pendingChurnCount;
    if (pending > 0) {
      const warn = containerEl.createEl('p', {
        text: `Blocked: ${String(pending)} notes would change identity. Review before continuing.`,
      });
      warn.style.color = 'var(--text-error)';
      new Setting(containerEl)
        .setName('Allow identity change once')
        .setDesc('Let the next sync adopt the blocked identities a single time.')
        .addButton((button) =>
          button.setButtonText('Allow once').onClick(() => {
            this.plugin.allowIdentityChurnOnce();
            new Notice('Tephra: identity change allowed once.');
            this.display();
          }),
        );
    }

    new Setting(containerEl)
      .setName('Remove Tephra IDs from notes')
      .setDesc(
        'Delete the tephra-file-id property from every note in the vault. Run this after ' +
          'switching to the sidecar, so identity is harvested first. This rewrites files and ' +
          'cannot be undone by Tephra — back up first.',
      )
      .addButton((button) =>
        button
          .setButtonText('Remove file IDs…')
          .setWarning()
          .onClick(() => void this.plugin.removeFileIdsFromAllNotes()),
      );
  }

  private async previewMigration(target: IdentityMode): Promise<void> {
    const from = this.plugin.state.settings.identityMode;
    const report = await this.plugin.previewIdentityMigration(target);
    const modal = new IdentityMigrationModal(this.app, {
      from,
      to: target,
      report,
      offerHarvestThenRemove: from === 'frontmatter' && target === 'sidecar',
      onConfirm: ({ removeAfterHarvest }) => {
        void this.plugin
          .executeIdentityMigration(target, { removeAfterHarvest })
          .then(() => {
            new Notice(`Tephra: note identity is now "${target}". Repair fetch queued for next sync.`);
            this.display();
          })
          .catch((error: unknown) => {
            new Notice(
              `Tephra: identity switch failed: ${error instanceof Error ? error.message : 'unknown error'}`,
            );
          });
      },
    });
    modal.open();
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
