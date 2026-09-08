import { Notice, Plugin, TFile } from 'obsidian';
import { parseState, type IdentityMode, type TephraPluginState } from './state/plugin-state';
import {
  loadIdentityStore,
  saveIdentityStore,
  type IdentityStoreAdapter,
} from './state/identity-store';
import { EventBuffer, type VaultEvent } from './sync/event-buffer';
import { SyncCoordinator, type SyncStatus } from './sync/coordinator';
import { FILE_ID_PROPERTY, VaultScanner, shouldSyncPath } from './sync/scanner';
import { mintFileId, randomFileId } from './sync/identity/id-mint';
import {
  dryRunIdentityMigration,
  harvestFrontmatterIds,
  writeSidecarIdsToFrontmatter,
  type MigrationDryRun,
  type MigrationEntry,
} from './sync/identity/migrations';
import { removeFileIds, scanForFileIds } from './sync/id-cleanup';
import { StatusDisplay } from './ui/status';
import { RemoveFileIdsConfirmModal } from './ui/confirm-modal';
import { TephraSettingTab } from './ui/settings-tab';

const RECONCILIATION_INTERVAL_MS = 10 * 60 * 1_000;

export default class TephraPlugin extends Plugin {
  state!: TephraPluginState;
  status!: StatusDisplay;
  private coordinator!: SyncCoordinator;
  private scanner!: VaultScanner;
  /** In-memory sidecar id map, held by reference by the scanner and coordinator. */
  private readonly identityIds = new Map<string, string>();
  private eventBuffer: EventBuffer | undefined;
  private readonly suppressedModify = new Set<string>();

  async onload(): Promise<void> {
    this.state = parseState(await this.loadData());
    if (!this.state.settings.deviceId) {
      this.state.settings.deviceId = `device_${globalThis.crypto.randomUUID()}`;
      await this.persistState();
    }
    this.status = new StatusDisplay(this.addStatusBarItem());
    this.addSettingTab(new TephraSettingTab(this.app, this));
    this.addCommand({ id: 'sync-now', name: 'Sync now', callback: () => void this.syncNow(true) });
    this.addCommand({
      id: 'repair-identities',
      name: 'Repair note identities from server',
      callback: () => void this.repairIdentitiesFromServer(),
    });
    this.addCommand({
      id: 'remove-file-ids',
      name: 'Remove file IDs from all notes',
      callback: () => void this.removeFileIdsFromAllNotes(),
    });

    this.app.workspace.onLayoutReady(() => void this.startAfterLayoutReady());
  }

  onunload(): void {
    this.eventBuffer?.dispose();
    this.eventBuffer = undefined;
  }

  async persistState(): Promise<void> {
    await this.saveData(this.state);
  }

  /** Manual repair entry point for settings (plan 010, §9.3, trigger 4). */
  async repairIdentitiesFromServer(): Promise<void> {
    if (!this.coordinator) return;
    await this.coordinator.repairIdentitiesFromServer();
  }

  /** Pending churn-guard block size for the settings warning; 0 when clear. */
  get pendingChurnCount(): number {
    return this.coordinator?.pendingChurnCount ?? 0;
  }

  /** Settings "Allow once" action: let one over-threshold batch through. */
  allowIdentityChurnOnce(): void {
    this.coordinator?.allowChurnOnce();
  }

  async settingsChanged(sync = true): Promise<void> {
    await this.persistState();
    await this.refreshIdentityStore();
    if (!this.state.settings.enableSync) {
      this.eventBuffer?.dispose();
      this.eventBuffer = undefined;
      this.updateStatus({ phase: 'disabled', message: 'Managed (Sync Off)', at: Date.now() });
      return;
    }
    this.createEventBuffer();
    if (sync && this.coordinator) await this.syncNow(false);
  }

  async syncNow(showNotice = false): Promise<void> {
    if (!this.state.settings.enableSync) {
      if (showNotice)
        new Notice('Tephra direct sync is disabled (Sidecar / External Sync mode).');
      return;
    }
    if (!this.coordinator) return;
    try {
      await this.coordinator.requestSync();
      if (showNotice && this.status.get().phase === 'success')
        new Notice(this.status.get().message);
    } catch {
      if (showNotice) new Notice(this.status.get().message);
    }
  }

  /**
   * Destructive sweep from the command palette or settings: preview every
   * note carrying a `tephra-file-id`, confirm explicitly, then remove them
   * all and report a summary. Also callable from the settings tab.
   */
  async removeFileIdsFromAllNotes(opts: { harvested?: boolean } = {}): Promise<void> {
    const preview = await scanForFileIds(this.app);
    if (preview.length === 0) {
      new Notice('Tephra: no file IDs found — nothing to remove.');
      return;
    }
    const confirmed = await new Promise<boolean>((resolve) => {
      const modal = new RemoveFileIdsConfirmModal(this.app, {
        count: preview.length,
        harvested: opts.harvested ?? false,
        syncOnAndFrontmatter:
          this.state.settings.enableSync && this.state.settings.identityMode === 'frontmatter',
        onConfirm: () => resolve(true),
        onCancel: () => resolve(false),
        onDisableSync: () => {
          this.state.settings.enableSync = false;
          void this.settingsChanged(false);
        },
      });
      modal.open();
    });
    if (!confirmed) return;
    const result = await removeFileIds(this.app, preview, {
      beforeWrite: (path) => {
        this.suppressedModify.add(path);
        window.setTimeout(() => this.suppressedModify.delete(path), 5_000);
      },
    });
    if (result.failed.length > 0) {
      console.warn('[tephra] Failed to remove file IDs from:', result.failed);
    }
    new Notice(
      `Tephra: removed file IDs from ${String(result.removed)} notes ` +
        `(${String(result.skipped)} skipped, ${String(result.failed.length)} failed).`,
    );
  }

  /**
   * Dry-run a mode switch for the settings preview (plan 010, §12): one
   * entry per syncable file — sidecar id as the server-known approximation,
   * metadataCache frontmatter as the harvestable identity, stat size for the
   * re-upload estimate.
   */
  async previewIdentityMigration(to: IdentityMode): Promise<MigrationDryRun> {
    const entries: MigrationEntry[] = [];
    for (const file of this.app.vault.getFiles()) {
      const path = file.path.normalize('NFC');
      if (!shouldSyncPath(path)) continue;
      const kind = file.extension.toLowerCase() === 'md' ? 'markdown' : 'attachment';
      let frontmatterId: string | undefined;
      if (kind === 'markdown') {
        try {
          const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
          const cached = frontmatter?.[FILE_ID_PROPERTY];
          if (typeof cached === 'string' && cached.trim()) frontmatterId = cached.trim();
        } catch {
          // Cache lookup failed; the entry simply carries no frontmatter id.
        }
      }
      entries.push({
        path,
        kind,
        size: file.stat.size,
        currentId: this.identityIds.get(path),
        frontmatterId,
      });
    }
    return dryRunIdentityMigration(this.state.settings.identityMode, to, entries, {
      vaultId: this.state.settings.vaultId,
    });
  }

  /**
   * Execute a confirmed mode switch (plan 010, §12). Any switch clears
   * pendingRenames and forces a repair fetch on the next sync, so the
   * server's view is authoritative before anything is committed.
   */
  async executeIdentityMigration(
    to: IdentityMode,
    opts: { removeAfterHarvest?: boolean } = {},
  ): Promise<void> {
    const from = this.state.settings.identityMode;
    if (from === to) return;
    const adapter = this.app.vault.adapter as unknown as IdentityStoreAdapter;
    const suppress = (path: string): void => {
      this.suppressedModify.add(path);
      window.setTimeout(() => this.suppressedModify.delete(path), 5_000);
    };
    if (to === 'sidecar') {
      // A→B harvest / C→B adopt: fill sidecar gaps from frontmatter, zero
      // churn. Set-if-absent: stale frontmatter leftovers must never clobber
      // a live sidecar binding.
      const harvested = await harvestFrontmatterIds(this.app);
      for (const [rawPath, id] of harvested) {
        const path = rawPath.normalize('NFC');
        if (!this.identityIds.has(path)) this.identityIds.set(path, id);
      }
    } else if (to === 'frontmatter') {
      // B→A: write each sidecar id into the file's frontmatter. Failures
      // keep their sidecar id and are listed; the sidecar is retained.
      const targets = new Map<string, string>();
      for (const file of this.app.vault.getMarkdownFiles()) {
        const id = this.identityIds.get(file.path.normalize('NFC'));
        if (id) targets.set(file.path, id);
      }
      const result = await writeSidecarIdsToFrontmatter(this.app, targets, {
        beforeWrite: suppress,
      });
      if (result.failed.length > 0) {
        console.warn('[tephra] B→A migration: failed to write frontmatter IDs for:', result.failed);
        new Notice(
          `Tephra: wrote IDs to ${String(result.written.length)} notes, ` +
            `${String(result.failed.length)} failed (sidecar IDs kept).`,
        );
      }
    } else {
      // anything→C: every file mints fresh. Sets allowIdentityChurnOnce on
      // confirm so the next repair fetch lets the new ids through once.
      const claimed = new Set<string>();
      for (const file of this.app.vault.getFiles()) {
        const path = file.path.normalize('NFC');
        if (!shouldSyncPath(path)) continue;
        const kind = file.extension.toLowerCase() === 'md' ? 'markdown' : 'attachment';
        let id = await mintFileId(this.state.settings.vaultId, path, kind);
        while (claimed.has(id)) id = randomFileId();
        claimed.add(id);
        this.identityIds.set(path, id);
      }
      this.coordinator?.allowChurnOnce();
    }
    this.state.settings.identityMode = to;
    // Cleared in place: the scanner holds this array by reference.
    this.state.pendingRenames.length = 0;
    this.state.identityRepairNeeded = true;
    await this.persistState();
    await saveIdentityStore(adapter, this.state.settings.vaultId, this.identityIds);
    if (opts.removeAfterHarvest && to === 'sidecar') {
      // "Harvest then remove" sequence (§10.4): removal runs after harvest.
      await this.removeFileIdsFromAllNotes({ harvested: true });
    }
  }

  /** Load the sidecar cache through the vault adapter, in place so the scanner's reference stays live. */
  private async refreshIdentityStore(): Promise<void> {
    const adapter = this.app.vault.adapter as unknown as IdentityStoreAdapter;
    const vaultId = this.state.settings.vaultId;
    if (!vaultId) {
      this.identityIds.clear();
      this.state.identityRepairNeeded = true;
      return;
    }
    const loaded = await loadIdentityStore(adapter, vaultId);
    this.identityIds.clear();
    for (const [path, id] of loaded.ids) this.identityIds.set(path, id);
    this.state.identityRepairNeeded = loaded.repairNeeded;
  }

  private async startAfterLayoutReady(): Promise<void> {
    await this.refreshIdentityStore();
    const adapter = this.app.vault.adapter as unknown as IdentityStoreAdapter;
    this.scanner = new VaultScanner(
      this.app,
      {
        identityMode: this.state.settings.identityMode,
        vaultId: this.state.settings.vaultId,
        sidecar: this.identityIds,
        scanCache: this.state.scanCache,
        pendingRenames: this.state.pendingRenames,
      },
      (path) => {
        this.suppressedModify.add(path);
        window.setTimeout(() => this.suppressedModify.delete(path), 5_000);
      },
    );
    this.coordinator = new SyncCoordinator({
      app: this.app,
      state: this.state,
      scanner: this.scanner,
      saveState: () => this.persistState(),
      setStatus: (status) => this.updateStatus(status),
      identityStore: {
        ids: this.identityIds,
        save: (ids) => saveIdentityStore(adapter, this.state.settings.vaultId, ids),
      },
    });

    if (this.state.settings.enableSync) {
      this.createEventBuffer();
      void this.syncNow(false);
    } else {
      this.updateStatus({ phase: 'disabled', message: 'Managed (Sync Off)', at: Date.now() });
    }

    this.registerEvent(this.app.vault.on('create', (file) => this.bufferFileEvent('create', file)));
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (this.suppressedModify.delete(file.path)) return;
        this.bufferFileEvent('modify', file);
      }),
    );
    this.registerEvent(
      this.app.vault.on('delete', (file) =>
        this.bufferPathEvent({ type: 'delete', path: file.path }),
      ),
    );
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (file instanceof TFile && shouldSyncPath(file.path)) {
          this.bufferPathEvent({ type: 'rename', path: file.path, oldPath });
        } else if (shouldSyncPath(oldPath)) {
          this.bufferPathEvent({ type: 'delete', path: oldPath });
        }
      }),
    );
    this.registerInterval(
      window.setInterval(() => {
        if (this.state.settings.enableSync) void this.syncNow(false);
      }, RECONCILIATION_INTERVAL_MS),
    );
  }

  private createEventBuffer(): void {
    this.eventBuffer?.dispose();
    this.eventBuffer = new EventBuffer(
      (events) => void this.coordinator.handleEvents(events).catch(() => undefined),
      this.state.settings.debounceMs,
    );
  }

  private bufferFileEvent(type: 'create' | 'modify', file: unknown): void {
    if (file instanceof TFile && shouldSyncPath(file.path))
      this.bufferPathEvent({ type, path: file.path });
  }

  private bufferPathEvent(event: VaultEvent): void {
    if (!this.state.settings.enableSync) return;
    this.eventBuffer?.add(event);
  }

  private updateStatus(status: SyncStatus): void {
    this.status.set(status);
    if (status.phase === 'auth-error') new Notice('Tephra authentication failed.');
  }
}
