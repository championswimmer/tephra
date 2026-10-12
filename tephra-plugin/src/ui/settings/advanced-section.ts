import { Setting } from 'obsidian';
import type { SettingsContext } from './context';

export function renderAdvancedSection(ctx: SettingsContext, containerEl: HTMLElement): void {
  const { plugin } = ctx;
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
      text.setValue(plugin.state.settings.deviceId).setDisabled(true);
    });

  new Setting(content)
    .setName('Device Name')
    .setDesc('Friendly device name sent to Tephra.')
    .addText((text) =>
      text.setValue(plugin.state.settings.deviceName).onChange(async (value) => {
        plugin.state.settings.deviceName = value.trim() || 'Obsidian';
        await plugin.persistState();
      }),
    );

  new Setting(content)
    .setName('Manual Vault ID or name')
    .setDesc(
      'Override the bound vault directly: paste either the vault ID or its unique name. ' +
        'The next sync canonicalizes it to both (web links use the name).',
    )
    .addText((text) =>
      text.setValue(plugin.state.settings.vaultId).onChange(async (value) => {
        const next = value.trim();
        if (next === plugin.state.settings.vaultId) return;
        plugin.state.settings.vaultId = next;
        // The cached name belonged to the previous binding; the next
        // sync re-resolves (or clears) it via ensureVaultBinding.
        plugin.state.settings.vaultName = '';
        await plugin.settingsChanged(false);
      }),
    );

  new Setting(content)
    .setName('Manual Upload Token')
    .setDesc('Override upload token directly.')
    .addText((text) => {
      text.inputEl.type = 'password';
      text
        .setPlaceholder('Vault-scoped token')
        .setValue(plugin.state.settings.uploadToken)
        .onChange(async (value) => {
          plugin.state.settings.uploadToken = value;
          await plugin.settingsChanged(false);
        });
    });
}
