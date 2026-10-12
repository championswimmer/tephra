import { PluginSettingTab } from 'obsidian';
import type { App } from 'obsidian';
import type TephraPlugin from '../main';
import { renderAccountSection } from './settings/account-section';
import { renderAdvancedSection } from './settings/advanced-section';
import type { SettingsContext, SettingsFormState } from './settings/context';
import { renderIdentitySection } from './settings/identity-section';
import { renderServerSection } from './settings/server-section';
import { renderSyncSection } from './settings/sync-section';
import { renderVaultSection } from './settings/vault-section';

export class TephraSettingTab extends PluginSettingTab {
  private readonly form: SettingsFormState = {
    loginEmail: '',
    loginPassword: '',
    newVaultName: '',
    availableVaults: [],
    selectedVaultId: '',
    isFetchingVaults: false,
  };

  constructor(
    app: App,
    private readonly plugin: TephraPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    const ctx: SettingsContext = {
      app: this.app,
      plugin: this.plugin,
      form: this.form,
      refresh: () => {
        this.display();
      },
    };

    const currentStatus = this.plugin.status.get();
    containerEl.createEl('h2', { text: 'Tephra Cloud & Vault Control' });
    const statusDesc = containerEl.createEl('p', {
      cls: 'tephra-status-line',
      text: `Status: ${currentStatus.message}`,
    });
    statusDesc.style.color = 'var(--text-muted)';
    statusDesc.style.marginBottom = '1.5rem';

    renderServerSection(ctx, containerEl);
    renderAccountSection(ctx, containerEl);
    if (this.plugin.state.settings.auth) {
      renderVaultSection(ctx, containerEl);
    }
    renderIdentitySection(ctx, containerEl);
    renderSyncSection(ctx, containerEl);
    renderAdvancedSection(ctx, containerEl);
  }
}
