import { Notice, Setting } from 'obsidian';
import type { IdentityMode } from '../../state/plugin-state';
import { IdentityMigrationModal } from '../identity-migration-modal';
import type { SettingsContext } from './context';

/**
 * Note-identity mode selection (plan 010, §11.1). Rendered only when
 * direct sync is on. Switching never happens silently: the dropdown picks
 * a target mode and Preview changes always dry-runs first.
 */
export function renderIdentitySection(ctx: SettingsContext, containerEl: HTMLElement): void {
  const { plugin, refresh } = ctx;
  if (!plugin.state.settings.enableSync) return;
  containerEl.createEl('h3', { text: 'Note Identity' });

  const current = plugin.state.settings.identityMode;
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
          selected === plugin.state.settings.identityMode
            ? `Currently active: ${selected}.`
            : `Currently active: ${plugin.state.settings.identityMode}. Preview and confirm to switch to ${selected}.`,
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
      button.setButtonText('Preview changes…').onClick(() => void previewMigration(ctx, selected)),
    );

  new Setting(containerEl)
    .setName('Repair identities from server')
    .setDesc('Re-fetch the server file list and re-resolve local identities.')
    .addButton((button) =>
      button.setButtonText('Repair now').onClick(async () => {
        button.setDisabled(true);
        try {
          await plugin.repairIdentitiesFromServer();
          new Notice('Tephra: identity repair requested.');
        } catch {
          new Notice('Tephra: identity repair failed — see settings status.');
        } finally {
          button.setDisabled(false);
          refresh();
        }
      }),
    );

  const pending = plugin.pendingChurnCount;
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
          plugin.allowIdentityChurnOnce();
          new Notice('Tephra: identity change allowed once.');
          refresh();
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
        .onClick(() => void plugin.removeFileIdsFromAllNotes()),
    );
}

async function previewMigration(ctx: SettingsContext, target: IdentityMode): Promise<void> {
  const { app, plugin, refresh } = ctx;
  const from = plugin.state.settings.identityMode;
  const report = await plugin.previewIdentityMigration(target);
  const modal = new IdentityMigrationModal(app, {
    from,
    to: target,
    report,
    offerHarvestThenRemove: from === 'frontmatter' && target === 'sidecar',
    onConfirm: ({ removeAfterHarvest }) => {
      void plugin
        .executeIdentityMigration(target, { removeAfterHarvest })
        .then(() => {
          new Notice(`Tephra: note identity is now "${target}". Repair fetch queued for next sync.`);
          refresh();
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
