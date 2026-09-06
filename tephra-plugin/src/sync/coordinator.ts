import type { App, TFile } from 'obsidian';
import { TephraClient, TephraHttpError } from '../api/client';
import type { TephraClientLike } from '../api/client';
import type { TephraPluginState, LocalFileState } from '../state/plugin-state';
import type { VaultEvent } from './event-buffer';
import { manifestHash } from './manifest';
import { SerializedReconciler } from './reconciliation';
import type { VaultScanner } from './scanner';
import { uploadMissingBlobs } from './uploader';
import type { BlobSource } from './uploader';

export type SyncPhase =
  | 'idle'
  | 'disabled'
  | 'scanning'
  | 'planning'
  | 'uploading'
  | 'committing'
  | 'success'
  | 'offline'
  | 'auth-error'
  | 'error';
export interface SyncStatus {
  phase: SyncPhase;
  message: string;
  at: number;
}

export interface CoordinatorOptions {
  app: App;
  state: TephraPluginState;
  saveState: () => Promise<void>;
  setStatus: (status: SyncStatus) => void;
  scanner: VaultScanner;
  clientFactory?: () => TephraClientLike;
}

export class SyncCoordinator {
  private readonly queue: SerializedReconciler;
  private readonly renamedPaths = new Map<string, string>();

  constructor(private readonly options: CoordinatorOptions) {
    this.queue = new SerializedReconciler(() => this.reconcile());
  }

  requestSync(): Promise<void> {
    return this.queue.request();
  }

  async handleEvents(events: readonly VaultEvent[]): Promise<void> {
    let attachmentMappingChanged = false;
    for (const event of events) {
      if (event.type === 'rename') {
        this.renamedPaths.set(event.oldPath, event.path);
        const id = this.options.state.attachmentIds[event.oldPath];
        if (id) {
          delete this.options.state.attachmentIds[event.oldPath];
          this.options.state.attachmentIds[event.path] = id;
          attachmentMappingChanged = true;
        }
      }
    }
    if (attachmentMappingChanged) await this.options.saveState();
    await this.requestSync();
  }

  private async reconcile(): Promise<void> {
    const { state } = this.options;
    if (!state.settings.enableSync) {
      this.status('disabled', 'Managed (Sync Off)');
      return;
    }
    if (
      !state.settings.serverUrl ||
      !state.settings.vaultId ||
      !state.settings.uploadToken ||
      !state.settings.deviceId
    ) {
      this.status('idle', 'Configure the server, vault, and upload token to sync.');
      return;
    }
    try {
      this.status('scanning', 'Scanning vault…');
      const previous = this.previousWithRenames();
      const scanned = await this.options.scanner.scan(previous, state.attachmentIds);
      // Attachment identities are local metadata and must survive an offline first scan.
      state.attachmentIds = scanned.attachmentIds;
      await this.options.saveState();
      const hash = await manifestHash(scanned.files);
      const body = { deviceId: state.settings.deviceId, manifestHash: hash, files: scanned.files };
      const client =
        this.options.clientFactory?.() ??
        new TephraClient(
          state.settings.serverUrl,
          state.settings.vaultId,
          state.settings.uploadToken,
        );
      this.status('planning', 'Checking remote vault…');
      const plan = await client.plan(body);
      if (plan.missingBlobs.length > 0) {
        this.status('uploading', `Uploading ${String(plan.missingBlobs.length)} blob(s)…`);
        await uploadMissingBlobs(
          client,
          this.blobSource(),
          scanned.files,
          plan.missingBlobs.map((blob) => blob.hash),
          { concurrency: state.settings.concurrency },
        );
      }
      let revision = plan.latestRevision;
      if (plan.status !== 'up-to-date') {
        this.status('committing', 'Committing complete manifest…');
        revision = (await client.commit(body)).revision;
      }
      state.manifest = Object.fromEntries(
        scanned.files.map((file) => [file.path, file as LocalFileState]),
      );
      state.lastSuccessfulSyncAt = Date.now();
      state.lastRemoteRevision = revision;
      this.renamedPaths.clear();
      await this.options.saveState();
      this.status('success', `Synced revision ${String(revision)}.`);
    } catch (error) {
      if (error instanceof TephraHttpError && (error.status === 401 || error.status === 403)) {
        this.status('auth-error', 'Authentication failed. Check the upload token and vault ID.');
      } else if (
        error instanceof TypeError ||
        (error instanceof TephraHttpError && (error.status === 0 || error.status >= 500))
      ) {
        this.status('offline', 'Server unavailable. Local changes are safe; sync will retry.');
      } else {
        this.status('error', error instanceof Error ? error.message : 'Sync failed.');
      }
      throw error;
    }
  }

  private previousWithRenames(): Record<string, LocalFileState> {
    const previous = { ...this.options.state.manifest };
    for (const [oldPath, newPath] of this.renamedPaths) {
      const entry = previous[oldPath];
      if (!entry) continue;
      delete previous[oldPath];
      previous[newPath] = { ...entry, path: newPath };
    }
    return previous;
  }

  private blobSource(): BlobSource {
    return {
      read: async (path, markdown) => {
        const file = this.options.app.vault.getAbstractFileByPath(path) as TFile | null;
        if (!file || typeof file.extension !== 'string')
          throw new Error(`File disappeared during sync: ${path}`);
        return markdown
          ? new TextEncoder().encode(await this.options.app.vault.read(file))
          : new Uint8Array(await this.options.app.vault.readBinary(file));
      },
    };
  }

  private status(phase: SyncPhase, message: string): void {
    this.options.setStatus({ phase, message, at: Date.now() });
  }
}
