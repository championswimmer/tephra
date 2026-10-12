import { Setting } from 'obsidian';
import type { SettingsContext } from './context';

export function renderSyncSection(ctx: SettingsContext, containerEl: HTMLElement): void {
  const { plugin, refresh } = ctx;
  containerEl.createEl('h3', { text: 'Vault Synchronization' });

  new Setting(containerEl)
    .setName('Enable Direct Sync')
    .setDesc(
      'Upload local notes and attachments directly to Tephra. Turn this off if your vault is synchronized via the Obsidian Sync sidecar or another service to prevent duplicate work.',
    )
    .addToggle((toggle) =>
      toggle
        .setValue(plugin.state.settings.enableSync)
        .onChange(async (val) => {
          plugin.state.settings.enableSync = val;
          await plugin.settingsChanged(val);
          refresh();
        }),
    );

  if (plugin.state.settings.enableSync) {
    new Setting(containerEl)
      .setName('Manual Sync')
      .setDesc('Reconcile local changes with the remote vault immediately.')
      .addButton((button) =>
        button
          .setButtonText('Sync now')
          .setCta()
          .onClick(() => void plugin.syncNow(true)),
      );

    if (plugin.state.lastSuccessfulSyncAt) {
      containerEl.createEl('p', {
        text: `Last successful sync: ${new Date(plugin.state.lastSuccessfulSyncAt).toLocaleString()} (revision ${String(plugin.state.lastRemoteRevision ?? 0)})`,
      });
    }

    new Setting(containerEl)
      .setName('Debounce (milliseconds)')
      .setDesc('Wait period after file modifications before triggering sync.')
      .addText((text) =>
        text.setValue(String(plugin.state.settings.debounceMs)).onChange(async (value) => {
          const parsed = Number(value);
          if (Number.isFinite(parsed) && parsed >= 250 && parsed <= 60_000) {
            plugin.state.settings.debounceMs = Math.floor(parsed);
            await plugin.settingsChanged(false);
          }
        }),
      );

    new Setting(containerEl)
      .setName('Upload Concurrency')
      .setDesc('Maximum simultaneous blob uploads (1 - 10).')
      .addText((text) =>
        text.setValue(String(plugin.state.settings.concurrency)).onChange(async (value) => {
          const parsed = Number(value);
          if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 10) {
            plugin.state.settings.concurrency = parsed;
            await plugin.settingsChanged(false);
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
        .onClick(() => void plugin.removeFileIdsFromAllNotes()),
    );
}
