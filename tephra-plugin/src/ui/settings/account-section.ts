import { Notice, Setting } from 'obsidian';
import { TephraClient } from '../../api/client';
import type { SettingsContext } from './context';

export function renderAccountSection(ctx: SettingsContext, containerEl: HTMLElement): void {
  const { plugin, form, refresh } = ctx;
  containerEl.createEl('h3', { text: 'Account & Authentication' });
  const auth = plugin.state.settings.auth;

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
              const client = new TephraClient(plugin.state.settings.serverUrl);
              await client.logout(auth.sessionToken);
            } catch {
              /* Clear local auth even if network logout failed */
            }
            delete plugin.state.settings.auth;
            await plugin.settingsChanged(false);
            new Notice('Logged out from Tephra.');
            refresh();
          }),
      );
  } else {
    new Setting(containerEl)
      .setName('Email / Username')
      .setDesc('Account email on your Tephra instance.')
      .addText((text) =>
        text
          .setPlaceholder('user@example.com')
          .setValue(form.loginEmail)
          .onChange((val) => {
            form.loginEmail = val.trim();
          }),
      );

    new Setting(containerEl)
      .setName('Password')
      .setDesc('Your Tephra account password.')
      .addText((text) => {
        text.inputEl.type = 'password';
        text
          .setPlaceholder('Password')
          .setValue(form.loginPassword)
          .onChange((val) => {
            form.loginPassword = val;
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
            const url = plugin.state.settings.serverUrl.trim();
            if (!url) {
              new Notice('Please configure Server URL first.');
              return;
            }
            if (!form.loginEmail || !form.loginPassword) {
              new Notice('Please provide both email and password.');
              return;
            }
            button.setDisabled(true);
            try {
              const client = new TephraClient(url);
              const res = await client.login(form.loginEmail, form.loginPassword);
              plugin.state.settings.auth = {
                sessionToken: res.sessionToken,
                userId: res.user.id,
                userEmail: res.user.email,
              };
              form.loginPassword = '';
              await plugin.persistState();
              new Notice(`Welcome, ${res.user.email}!`);
              refresh();
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
