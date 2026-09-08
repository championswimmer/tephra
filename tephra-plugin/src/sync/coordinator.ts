import type { App, TFile } from 'obsidian';
import type { SyncManifestEntry, SyncPlanResponse } from '@tephra/protocol';
import { TephraClient, TephraHttpError } from '../api/client';
import type { TephraClientLike } from '../api/client';
import type { TephraPluginState, LocalFileState } from '../state/plugin-state';
import type { VaultEvent } from './event-buffer';
import { manifestHash } from './manifest';
import { SerializedReconciler } from './reconciliation';
import type { ScanResult, VaultScanner } from './scanner';
import { uploadMissingBlobs } from './uploader';
import type { BlobSource } from './uploader';

export type SyncPhase =
  | 'idle'
  | 'disabled'
  | 'scanning'
  | 'planning'
  | 'repairing'
  | 'uploading'
  | 'committing'
  | 'success'
  | 'offline'
  | 'needs-identity-repair'
  | 'auth-error'
  | 'error';
export interface SyncStatus {
  phase: SyncPhase;
  message: string;
  at: number;
}

/** Sidecar handle: the in-memory id map plus its persistence. */
export interface IdentityStoreHandle {
  ids: Map<string, string>;
  save(ids: ReadonlyMap<string, string>): Promise<void>;
}

export interface CoordinatorOptions {
  app: App;
  state: TephraPluginState;
  saveState: () => Promise<void>;
  setStatus: (status: SyncStatus) => void;
  scanner: VaultScanner;
  clientFactory?: () => TephraClientLike;
  identityStore?: IdentityStoreHandle | undefined;
}

/**
 * Merge a rename hint into the durable list, collapsing chains explicitly
 * (plan 010, §8, Stage 0): an existing `[A, oldPath]` plus an incoming
 * `[oldPath, newPath]` becomes `[A, newPath]`. Paths are NFC-normalized.
 */
export function addRenameHint(
  hints: Array<[string, string]>,
  oldPath: string,
  newPath: string,
): boolean {
  const from = oldPath.normalize('NFC');
  const to = newPath.normalize('NFC');
  if (from === to) return false;
  if (hints.some((hint) => hint[0] === from && hint[1] === to)) return false;
  for (let index = hints.length - 1; index >= 0; index -= 1) {
    if (hints[index]?.[0] === from) hints.splice(index, 1);
  }
  const chained = hints.find((hint) => hint[1] === from);
  if (chained) {
    chained[1] = to;
    return true;
  }
  hints.push([from, to]);
  return true;
}

function mapsEqual(left: ReadonlyMap<string, string>, right: ReadonlyMap<string, string>): boolean {
  if (left.size !== right.size) return false;
  for (const [path, id] of left) {
    if (right.get(path) !== id) return false;
  }
  return true;
}

/** Manifest validation failures carry DUPLICATE_* codes (400) — self-heal by repairing and retrying once. */
function isDuplicateError(error: unknown): boolean {
  return error instanceof TephraHttpError && /DUPLICATE_(FILE_ID|PATH)/.test(error.message);
}

function isOfflineError(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error instanceof TephraHttpError && (error.status === 0 || error.status >= 500))
  );
}

export class SyncCoordinator {
  private readonly queue: SerializedReconciler;
  /** Set by the settings UI to let one over-threshold repair through. */
  public allowIdentityChurnOnce = false;
  /** Set by "Repair identities from server"; consumed by the next reconcile. */
  private repairRequested = false;
  /**
   * Last churn-guard block, surfaced to the settings tab as an inline
   * warning with an allow-once action (plan 010, §11.1). Cleared when the
   * user allows once or a later guard check passes.
   */
  private lastChurnBlock: { count: number; at: number } | undefined;

  constructor(private readonly options: CoordinatorOptions) {
    this.queue = new SerializedReconciler(() => this.reconcile());
  }

  requestSync(): Promise<void> {
    return this.queue.request();
  }

  /** Force trigger 4 (manual repair) on the next reconcile. */
  async repairIdentitiesFromServer(): Promise<void> {
    this.repairRequested = true;
    await this.requestSync();
  }

  /** Pending churn-guard block size for the settings warning; 0 when clear. */
  get pendingChurnCount(): number {
    return this.lastChurnBlock?.count ?? 0;
  }

  /** Settings "Allow once" action: let one over-threshold batch through. */
  allowChurnOnce(): void {
    this.allowIdentityChurnOnce = true;
    this.lastChurnBlock = undefined;
  }

  async handleEvents(events: readonly VaultEvent[]): Promise<void> {
    let hintsChanged = false;
    for (const event of events) {
      if (event.type === 'rename') {
        hintsChanged =
          addRenameHint(this.options.state.pendingRenames, event.oldPath, event.path) || hintsChanged;
      }
    }
    // Durable across restart: hints must survive between the rename and the
    // next successful sync (plan 010, §7.4).
    if (hintsChanged) await this.options.saveState();
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
    // The scanner holds live references to the sidecar map, scanCache, and
    // pendingRenames; only the scalar settings need re-syncing here.
    this.options.scanner.identityMode = state.settings.identityMode;
    this.options.scanner.vaultId = state.settings.vaultId;
    const client =
      this.options.clientFactory?.() ??
      new TephraClient(
        state.settings.serverUrl,
        state.settings.vaultId,
        state.settings.uploadToken,
      );
    try {
      this.status('scanning', 'Scanning vault…');
      const scanned = await this.options.scanner.scan();
      let files = scanned.files;
      let hash = await manifestHash(files);
      let body = { deviceId: state.settings.deviceId, manifestHash: hash, files };
      this.status('planning', 'Checking remote vault…');
      let plan: SyncPlanResponse;
      try {
        plan = await client.plan(body);
      } catch (error) {
        if (isDuplicateError(error)) {
          ({ files, plan } = await this.repairAndReplan(client, 'Repairing note identities…'));
          hash = await manifestHash(files);
          body = { deviceId: state.settings.deviceId, manifestHash: hash, files };
        } else if (state.identityRepairNeeded && isOfflineError(error)) {
          // Offline rule (plan 010, §9.3): a missing sidecar plus an
          // unreachable server means no persist and no commit.
          this.status(
            'needs-identity-repair',
            'Identity repair needed: connect to the server to reconcile note identities.',
          );
          return;
        } else {
          throw error;
        }
      }

      let repairedThisRun = false;
      if (state.identityRepairNeeded || this.repairRequested || plan.latestRevision !== state.lastRemoteRevision) {
        if (plan.latestRevision === 0 && state.lastRemoteRevision === undefined) {
          // Empty vault: local minting is authoritative — persist it and
          // commit without a repair fetch (plan 010, §9.3, offline rule).
          await this.persistSidecar(scanned.sidecarUpdates);
          state.identityRepairNeeded = false;
          this.repairRequested = false;
        } else {
          ({ files, plan } = await this.repairAndReplan(client, 'Repairing note identities…'));
          repairedThisRun = true;
          hash = await manifestHash(files);
          body = { deviceId: state.settings.deviceId, manifestHash: hash, files };
        }
      } else {
        // No repair: persist locally minted ids eagerly (create/rename/delete
        // between syncs), before plan/upload/commit — but only when the map
        // actually changed, so steady-state editing never touches the sidecar.
        await this.persistSidecar(scanned.sidecarUpdates);
      }

      if (plan.missingBlobs.length > 0) {
        this.status('uploading', `Uploading ${String(plan.missingBlobs.length)} blob(s)…`);
        await uploadMissingBlobs(
          client,
          this.blobSource(),
          files,
          plan.missingBlobs.map((blob) => blob.hash),
          { concurrency: state.settings.concurrency },
        );
      }
      let revision = plan.latestRevision;
      if (plan.status !== 'up-to-date') {
        this.status('committing', 'Committing complete manifest…');
        try {
          revision = (await client.commit(body)).revision;
        } catch (error) {
          if (isDuplicateError(error) && !repairedThisRun) {
            ({ files, plan } = await this.repairAndReplan(client, 'Repairing note identities…'));
            hash = await manifestHash(files);
            body = { deviceId: state.settings.deviceId, manifestHash: hash, files };
            if (plan.missingBlobs.length > 0) {
              this.status('uploading', `Uploading ${String(plan.missingBlobs.length)} blob(s)…`);
              await uploadMissingBlobs(
                client,
                this.blobSource(),
                files,
                plan.missingBlobs.map((blob) => blob.hash),
                { concurrency: state.settings.concurrency },
              );
            }
            revision = (await client.commit(body)).revision;
          } else {
            throw error;
          }
        }
      }
      state.manifest = Object.fromEntries(
        files.map((file) => [file.path, file as LocalFileState]),
      );
      state.lastSuccessfulSyncAt = Date.now();
      state.lastRemoteRevision = revision;
      // Cleared in place: the scanner holds this array by reference.
      state.pendingRenames.length = 0;
      await this.options.saveState();
      this.status('success', `Synced revision ${String(revision)}.`);
    } catch (error) {
      if (error instanceof TephraHttpError && (error.status === 401 || error.status === 403)) {
        this.status('auth-error', 'Authentication failed. Check the upload token and vault ID.');
      } else if (isOfflineError(error)) {
        this.status('offline', 'Server unavailable. Local changes are safe; sync will retry.');
      } else {
        this.status('error', error instanceof Error ? error.message : 'Sync failed.');
      }
      throw error;
    }
  }

  /**
   * Repair cycle (plan 010, §9.3): fetch the server file list, re-resolve
   * with it as prev (`hash = blobHash`), enforce the churn guard, persist
   * the sidecar, rebuild the manifest hash, and plan again.
   */
  private async repairAndReplan(
    client: TephraClientLike,
    message: string,
  ): Promise<{ files: SyncManifestEntry[]; plan: SyncPlanResponse }> {
    this.status('repairing', message);
    const server = await client.listFiles();
    const reResolved: ScanResult = await this.options.scanner.resolveWithServerPrev(
      server.files.map((file) => ({ path: file.path, fileId: file.fileId, hash: file.blobHash })),
    );
    this.churnGuard(reResolved.files, reResolved.identityChanged);
    await this.persistSidecar(reResolved.sidecarUpdates);
    this.options.state.identityRepairNeeded = false;
    this.repairRequested = false;
    const hash = await manifestHash(reResolved.files);
    const plan = await client.plan({
      deviceId: this.options.state.settings.deviceId,
      manifestHash: hash,
      files: reResolved.files,
    });
    return { files: reResolved.files, plan };
  }

  /**
   * Churn guard (plan 010, §9.3): block when `identityChanged` — surviving
   * paths whose id differs, never legitimate outside a deliberate mode
   * switch or repair — exceeds `max(25, 2% of files)`. False-positive-free
   * by construction; `allowIdentityChurnOnce` lets one batch through.
   */
  private churnGuard(files: readonly SyncManifestEntry[], identityChanged: readonly string[]): void {
    const threshold = Math.max(25, Math.ceil(files.length * 0.02));
    if (identityChanged.length > threshold && !this.allowIdentityChurnOnce) {
      this.lastChurnBlock = { count: identityChanged.length, at: Date.now() };
      this.status(
        'error',
        `Blocked: ${String(identityChanged.length)} notes would change identity. Review before continuing.`,
      );
      throw new Error(
        `Identity churn guard blocked sync: ${String(identityChanged.length)} paths changed identity ` +
          `(threshold ${String(threshold)}). Set allowIdentityChurnOnce to proceed.`,
      );
    }
    this.allowIdentityChurnOnce = false;
    this.lastChurnBlock = undefined;
  }

  /** Persist the resolved id map, but only when it differs — steady-state syncs never touch the sidecar. */
  private async persistSidecar(sidecarUpdates: ReadonlyMap<string, string>): Promise<void> {
    const store = this.options.identityStore;
    if (!store) return;
    if (mapsEqual(store.ids, sidecarUpdates)) return;
    store.ids.clear();
    for (const [path, id] of sidecarUpdates) store.ids.set(path, id);
    await store.save(store.ids);
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
