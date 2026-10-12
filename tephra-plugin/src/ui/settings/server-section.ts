import { Notice, Setting } from 'obsidian';
import { TephraClient } from '../../api/client';
import type { SettingsContext } from './context';

export function renderServerSection(ctx: SettingsContext, containerEl: HTMLElement): void {
  const { plugin } = ctx;
  containerEl.createEl('h3', { text: 'Tephra Server' });

  new Setting(containerEl)
    .setName('Server URL')
    .setDesc('Base URL of your Tephra instance.')
    .addText((text) =>
      text
        .setPlaceholder('https://tephra.example.com')
        .setValue(plugin.state.settings.serverUrl)
        .onChange(async (value) => {
          plugin.state.settings.serverUrl = value.trim();
          await plugin.persistState();
        }),
    )
    .addButton((button) =>
      button.setButtonText('Test Connection').onClick(async () => {
        const url = plugin.state.settings.serverUrl.trim();
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
