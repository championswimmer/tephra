import { Modal, Setting, type ButtonComponent } from 'obsidian';
import type { App } from 'obsidian';

export interface RemoveFileIdsConfirmOptions {
  /** Number of notes that will be rewritten. */
  count: number;
  /** True when identity was harvested into `.tephra/data.json` first. */
  harvested: boolean;
  /** True when sync is on while the identity mode is still frontmatter. */
  syncOnAndFrontmatter: boolean;
  onConfirm: () => void;
  onCancel?: () => void;
  /** Called when the user picks the "turn sync off" fix-it action. */
  onDisableSync?: () => void;
}

/**
 * Destructive confirmation for the "remove Tephra file IDs" sweep (§10.3).
 * The confirm button stays disabled until the acknowledgement checkbox is
 * ticked, and is force-disabled while sync is on in frontmatter mode (IDs
 * would be re-added on the next scan).
 */
export class RemoveFileIdsConfirmModal extends Modal {
  private confirmButton: ButtonComponent | undefined;

  constructor(
    app: App,
    private readonly opts: RemoveFileIdsConfirmOptions,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    const { count, harvested, syncOnAndFrontmatter } = this.opts;
    contentEl.empty();
    contentEl.createEl('h2', { text: `Remove Tephra file IDs from ${count} notes?` });

    const list = contentEl.createEl('ul');
    list.createEl('li', {
      text: `This rewrites ${count} notes in your vault to delete the tephra-file-id property.`,
    });
    list.createEl('li', {
      text: 'It cannot be undone by Tephra. Back up the vault or commit to git first.',
    });
    if (harvested) {
      list.createEl('li', {
        text: 'Identity has been copied to .tephra/data.json — the server will see no change.',
      });
    } else {
      list.createEl('li', {
        text: 'Identity will be lost. On the next sync Tephra treats every note as new: rename history resets, and existing #file/<id> links break.',
      });
    }
    if (syncOnAndFrontmatter) {
      list.createEl('li', {
        text: 'Direct sync is on and identity mode is still "Frontmatter property" — IDs will be re-added on the next scan. Switch mode or turn sync off first.',
      });
    }

    const ackLabel = contentEl.createEl('label');
    ackLabel.style.display = 'flex';
    ackLabel.style.gap = '0.5rem';
    ackLabel.style.alignItems = 'center';
    ackLabel.style.margin = '1rem 0';
    const ackBox = ackLabel.createEl('input');
    ackBox.type = 'checkbox';
    ackLabel.appendText(`I understand this rewrites ${count} files.`);
    ackBox.addEventListener('change', () => this.refreshConfirmEnabled(ackBox.checked));

    const buttons = new Setting(contentEl);
    if (syncOnAndFrontmatter) {
      buttons.addButton((button) =>
        button.setButtonText('Turn sync off').onClick(() => {
          this.opts.onDisableSync?.();
          this.close();
        }),
      );
      const warn = contentEl.createEl('p', {
        text: 'Removal is disabled while sync is on: turn sync off, then run this again.',
      });
      warn.style.color = 'var(--text-error)';
    }
    buttons
      .addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()))
      .addButton((button) => {
        this.confirmButton = button
          .setButtonText(`Remove from ${count} notes`)
          .setWarning()
          .setDisabled(true)
          .onClick(() => {
            this.opts.onConfirm();
            this.close();
          });
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
    this.confirmButton?.setDisabled(!(checked && !this.opts.syncOnAndFrontmatter));
  }
}
