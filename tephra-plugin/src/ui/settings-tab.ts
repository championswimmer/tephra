import { PluginSettingTab, Setting } from 'obsidian';
import type { App } from 'obsidian';
import type TephraPlugin from '../main';

export class TephraSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: TephraPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    this.containerEl.empty();
    this.containerEl.createEl('h2', { text: 'Tephra Sync' });
    this.containerEl.createEl('p', { text: this.plugin.status.get().message });

    new Setting(this.containerEl)
      .setName('Server URL')
      .setDesc('Base URL of your Tephra server.')
      .addText((text) =>
        text
          .setPlaceholder('https://tephra.example.com')
          .setValue(this.plugin.state.settings.serverUrl)
          .onChange(async (value) => {
            this.plugin.state.settings.serverUrl = value.trim();
            await this.plugin.settingsChanged();
          }),
      );
    new Setting(this.containerEl).setName('Vault ID').addText((text) =>
      text.setValue(this.plugin.state.settings.vaultId).onChange(async (value) => {
        this.plugin.state.settings.vaultId = value.trim();
        await this.plugin.settingsChanged();
      }),
    );
    new Setting(this.containerEl)
      .setName('Upload token')
      .setDesc('Stored only in Obsidian plugin data.')
      .addText((text) => {
        text.inputEl.type = 'password';
        text
          .setPlaceholder('Vault-scoped token')
          .setValue(this.plugin.state.settings.uploadToken)
          .onChange(async (value) => {
            this.plugin.state.settings.uploadToken = value;
            await this.plugin.settingsChanged();
          });
      });
    new Setting(this.containerEl)
      .setName('Device ID')
      .setDesc('Generated once for this installation.')
      .addText((text) => {
        text.setValue(this.plugin.state.settings.deviceId).setDisabled(true);
      });
    new Setting(this.containerEl).setName('Device name').addText((text) =>
      text.setValue(this.plugin.state.settings.deviceName).onChange(async (value) => {
        this.plugin.state.settings.deviceName = value.trim() || 'Obsidian';
        await this.plugin.settingsChanged();
      }),
    );
    new Setting(this.containerEl).setName('Debounce (milliseconds)').addText((text) =>
      text.setValue(String(this.plugin.state.settings.debounceMs)).onChange(async (value) => {
        const parsed = Number(value);
        if (Number.isFinite(parsed) && parsed >= 250 && parsed <= 60_000) {
          this.plugin.state.settings.debounceMs = Math.floor(parsed);
          await this.plugin.settingsChanged(false);
        }
      }),
    );
    new Setting(this.containerEl).setName('Upload concurrency').addText((text) =>
      text.setValue(String(this.plugin.state.settings.concurrency)).onChange(async (value) => {
        const parsed = Number(value);
        if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 10) {
          this.plugin.state.settings.concurrency = parsed;
          await this.plugin.settingsChanged(false);
        }
      }),
    );
    new Setting(this.containerEl).setName('Manual sync').addButton((button) =>
      button
        .setButtonText('Sync now')
        .setCta()
        .onClick(() => void this.plugin.syncNow(true)),
    );
    if (this.plugin.state.lastSuccessfulSyncAt) {
      this.containerEl.createEl('p', {
        text: `Last successful sync: ${new Date(this.plugin.state.lastSuccessfulSyncAt).toLocaleString()} (revision ${String(this.plugin.state.lastRemoteRevision ?? 0)})`,
      });
    }
  }
}
