import { Modal, Setting, type ButtonComponent } from 'obsidian';
import type { App } from 'obsidian';
import type { IdentityMode } from '../state/plugin-state';
import { migrationNeedsConfirmation, type MigrationDryRun } from '../sync/identity/migrations';

export const IDENTITY_MODE_LABELS: Record<IdentityMode, string> = {
  frontmatter: 'Frontmatter property',
  sidecar: 'Sidecar file',
  path: 'Path only',
};

export interface IdentityMigrationModalOptions {
  from: IdentityMode;
  to: IdentityMode;
  report: MigrationDryRun;
  /** A→B only: offer the "harvest then remove" sequence (§10.4). */
  offerHarvestThenRemove?: boolean;
  onConfirm: (opts: { removeAfterHarvest: boolean }) => void;
  onCancel?: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Dry-run result display + explicit confirmation for a mode switch
 * (plan 010, §12). Styled after `RemoveFileIdsConfirmModal`: the confirm
 * button stays disabled until the acknowledgement checkbox is ticked.
 */
export class IdentityMigrationModal extends Modal {
  private confirmButton: ButtonComponent | undefined;

  constructor(
    app: App,
    private readonly opts: IdentityMigrationModalOptions,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    const { from, to, report, offerHarvestThenRemove } = this.opts;
    const needsConfirm = migrationNeedsConfirmation(report);
    contentEl.empty();
    contentEl.createEl('h2', {
      text: `Switch note identity to ${IDENTITY_MODE_LABELS[to]}?`,
    });

    const list = contentEl.createEl('ul');
    list.createEl('li', { text: `Identities preserved: ${String(report.preserved)}.` });
    list.createEl('li', { text: `Identities changed: ${String(report.changed)}.` });
    list.createEl('li', { text: `Notes to be rewritten: ${String(report.rewrites)}.` });
    list.createEl('li', {
      text: `Bytes to upload (approx): ${formatBytes(report.bytesToUpload)}.`,
    });
    list.createEl('li', {
      text: `Shared links that will break: ${String(report.linksBreaking)}.`,
    });
    if (from === 'frontmatter' && to === 'sidecar') {
      list.createEl('li', {
        text: 'Non-destructive: identities are copied to .tephra/data.json, so the next sync is a no-op. Removing the tephra-file-id property from notes is a separate step.',
      });
    } else if (from === 'sidecar' && to === 'frontmatter') {
      list.createEl('li', {
        text: 'Identities are preserved, but every rewritten note re-uploads. Files that fail keep their sidecar id, and the sidecar is retained as a fallback.',
      });
    } else if (to === 'path') {
      list.createEl('li', {
        text: 'Every changed note gets a new identity: delete plus create on the server, and previously shared links to the old path stop working.',
      });
    } else if (from === 'path' && to === 'sidecar') {
      list.createEl('li', { text: 'Current identities are adopted into the sidecar. Zero churn.' });
    }

    let removeAfterHarvestBox: HTMLInputElement | undefined;
    if (offerHarvestThenRemove && from === 'frontmatter' && to === 'sidecar') {
      const harvestLabel = contentEl.createEl('label');
      harvestLabel.style.display = 'flex';
      harvestLabel.style.gap = '0.5rem';
      harvestLabel.style.alignItems = 'center';
      harvestLabel.style.margin = '0.5rem 0';
      removeAfterHarvestBox = harvestLabel.createEl('input');
      removeAfterHarvestBox.type = 'checkbox';
      harvestLabel.appendText('Also remove tephra-file-id from notes afterwards (harvest then remove).');
    }

    const ackLabel = contentEl.createEl('label');
    ackLabel.style.display = 'flex';
    ackLabel.style.gap = '0.5rem';
    ackLabel.style.alignItems = 'center';
    ackLabel.style.margin = '1rem 0';
    const ackBox = ackLabel.createEl('input');
    ackBox.type = 'checkbox';
    ackLabel.appendText(
      needsConfirm
        ? `I understand ${String(report.changed)} notes will change identity.`
        : 'I understand this switches how Tephra remembers note identities.',
    );
    ackBox.addEventListener('change', () => this.refreshConfirmEnabled(ackBox.checked));

    new Setting(contentEl)
      .addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()))
      .addButton((button) => {
        this.confirmButton = button
          .setButtonText(`Switch to ${IDENTITY_MODE_LABELS[to]}`)
          .setDisabled(true)
          .onClick(() => {
            this.opts.onConfirm({ removeAfterHarvest: removeAfterHarvestBox?.checked ?? false });
            this.close();
          });
        if (needsConfirm) this.confirmButton.setWarning();
        else this.confirmButton.setCta();
      });
    this.refreshConfirmEnabled(ackBox.checked);
  }

  onClose(): void {
    this.contentEl.empty();
    // Note: also fires after onConfirm (which closes the modal); callers
    // should treat the confirm/cancel callbacks as first-wins.
    this.opts.onCancel?.();
  }

  private refreshConfirmEnabled(checked: boolean): void {
    this.confirmButton?.setDisabled(!checked);
  }
}
