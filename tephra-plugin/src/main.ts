import { Notice, Plugin, TFile } from 'obsidian';
import { parseState, type TephraPluginState } from './state/plugin-state';
import { EventBuffer, type VaultEvent } from './sync/event-buffer';
import { SyncCoordinator, type SyncStatus } from './sync/coordinator';
import { VaultScanner, shouldSyncPath } from './sync/scanner';
import { StatusDisplay } from './ui/status';
import { TephraSettingTab } from './ui/settings-tab';

const RECONCILIATION_INTERVAL_MS = 10 * 60 * 1_000;

export default class TephraPlugin extends Plugin {
  state!: TephraPluginState;
  status!: StatusDisplay;
  private coordinator!: SyncCoordinator;
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

    this.app.workspace.onLayoutReady(() => this.startAfterLayoutReady());
  }

  onunload(): void {
    this.eventBuffer?.dispose();
    this.eventBuffer = undefined;
  }

  async persistState(): Promise<void> {
    await this.saveData(this.state);
  }

  async settingsChanged(sync = true): Promise<void> {
    await this.persistState();
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

  private startAfterLayoutReady(): void {
    const scanner = new VaultScanner(this.app, (path) => {
      this.suppressedModify.add(path);
      window.setTimeout(() => this.suppressedModify.delete(path), 5_000);
    });
    this.coordinator = new SyncCoordinator({
      app: this.app,
      state: this.state,
      scanner,
      saveState: () => this.persistState(),
      setStatus: (status) => this.updateStatus(status),
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
