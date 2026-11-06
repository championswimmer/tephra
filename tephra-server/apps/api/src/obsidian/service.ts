import { watch, type FSWatcher } from 'node:fs';
import { lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { sha256Hex } from '@tephra/protocol';
import type { ObsidianSyncSettings, Vault } from '@tephra/vault-model';
import type { ApiDependencies } from '../http/types.js';
import { ApiFailure, fail } from '../http/errors.js';
import { DEFAULT_BLOB_LIMIT } from '../http/blob-write.js';
import {
  atomicNoteWrite,
  confinedPath,
  importCheckout,
  safeDirectory,
  visibleVaultPath,
} from './checkout.js';
import {
  clientStateRoot,
  nativeFailure,
  preparePaths,
  vaultPaths,
  type OfficialClient,
  type VaultPaths,
} from './cli.js';
import {
  initialObsidianSettings,
  type ObsidianLogin,
  type ObsidianSetup,
  type ObsidianSyncService,
} from './types.js';

class KeyedQueue {
  private readonly pending = new Map<string, Promise<unknown>>();
  run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.pending.set(key, next);
    void next
      .finally(() => {
        if (this.pending.get(key) === next) this.pending.delete(key);
      })
      .catch(() => undefined);
    return next;
  }
  async drain(): Promise<void> {
    await Promise.allSettled([...this.pending.values()]);
  }
}
interface Worker {
  controller: AbortController;
  done: Promise<void>;
}

export interface NativeSyncOptions {
  root: string;
  client: OfficialClient;
  maxVaults?: number;
  scanIntervalMs?: number;
  retryIntervalMs?: number;
}

export class NativeSyncService implements ObsidianSyncService {
  private readonly controls = new KeyedQueue();
  private readonly contents = new KeyedQueue();
  private readonly workers = new Map<string, Worker>();
  private readonly loginAttempts = new Map<string, number[]>();
  private closing = false;
  private readonly deleting = new Set<string>();
  constructor(
    private readonly dependencies: ApiDependencies,
    private readonly options: NativeSyncOptions,
  ) {}
  private paths(vault: Vault): VaultPaths {
    return vaultPaths(this.options.root, vault.id);
  }
  private assertOpen(vault?: Vault): void {
    if (this.closing || (vault && this.deleting.has(vault.id)))
      throw nativeFailure('OBSIDIAN_UNAVAILABLE');
  }
  async status(vault: Vault): Promise<ObsidianSyncSettings> {
    const settings = await this.dependencies.database.obsidianSync.find(vault.id);
    return settings ?? initialObsidianSettings(vault.id);
  }
  private async patch(vault: Vault, patch: Partial<ObsidianSyncSettings>): Promise<void> {
    // Transactional read/merge prevents a worker status update from undoing Pause.
    await this.dependencies.database.transaction(async (repositories) => {
      await repositories.lockVault(vault.id);
      if (!(await repositories.vaults.findById(vault.id))) return;
      const current =
        (await repositories.obsidianSync.find(vault.id)) ?? initialObsidianSettings(vault.id);
      await repositories.obsidianSync.upsert({ ...current, ...patch, vaultId: vault.id });
    });
  }

  private async privatePaths(vault: Vault): Promise<VaultPaths> {
    const paths = this.paths(vault);
    await preparePaths(paths);
    for (const directory of [paths.root, paths.config, paths.tmp]) await safeDirectory(directory);
    return paths;
  }
  private async stop(vault: Vault): Promise<void> {
    const worker = this.workers.get(vault.id);
    if (!worker) return;
    worker.controller.abort();
    await worker.done;
    if (this.workers.get(vault.id) === worker) this.workers.delete(vault.id);
  }
  private async capacity(vault: Vault): Promise<void> {
    const enabled = (await this.dependencies.database.obsidianSync.list()).filter(
      (row) => row.enabled && row.vaultId !== vault.id,
    );
    if (enabled.length >= (this.options.maxVaults ?? 5))
      fail(409, 'OBSIDIAN_SYNC_LIMIT', 'The server has reached its Obsidian Sync vault limit.');
  }
  async login(vault: Vault, input: ObsidianLogin): Promise<void> {
    this.assertOpen(vault);
    const now = this.dependencies.clock.now();
    const attempts = (this.loginAttempts.get(vault.id) ?? []).filter(
      (time) => time > now - 15 * 60_000,
    );
    if (attempts.length >= 5)
      fail(429, 'OBSIDIAN_RATE_LIMIT', 'Too many sign-in attempts. Try again in 15 minutes.');
    this.loginAttempts.set(vault.id, [...attempts, now]);
    return this.controls.run(vault.id, async () => {
      this.assertOpen(vault);
      await this.stop(vault);
      const paths = await this.privatePaths(vault);
      try {
        await this.options.client.login(paths, input);
        const state = await this.status(vault);
        await this.patch(vault, {
          phase: state.remoteVaultId ? 'stopped' : 'pending-remote',
          lastErrorCode: null,
        });
        if (state.enabled && state.remoteVaultId) this.launch(vault);
      } catch (error) {
        const failure =
          error instanceof ApiFailure ? error : nativeFailure('OBSIDIAN_LOGIN_FAILED');
        await this.patch(vault, { phase: 'error', lastErrorCode: failure.code });
        throw failure;
      }
    });
  }
  async remotes(vault: Vault) {
    this.assertOpen(vault);
    return this.controls.run(vault.id, async () => {
      this.assertOpen(vault);
      try {
        return await this.options.client.remotes(await this.privatePaths(vault));
      } catch (error) {
        throw error instanceof ApiFailure ? error : nativeFailure('OBSIDIAN_SYNC_FAILED');
      }
    });
  }
  async setup(vault: Vault, input: ObsidianSetup): Promise<void> {
    this.assertOpen(vault);
    // Global gate serializes capacity reservations across different vaults.
    return this.controls.run('capacity', () =>
      this.controls.run(vault.id, async () => {
        this.assertOpen(vault);
        await this.capacity(vault);
        const settings = await this.status(vault);
        if (settings.remoteVaultId && settings.remoteVaultId !== input.remoteVaultId)
          fail(
            409,
            'OBSIDIAN_SETUP_FAILED',
            'Create a new Tephra vault to connect a different remote vault.',
          );
        await this.patch(vault, { enabled: false });
        await this.stop(vault);
        const paths = await this.privatePaths(vault);
        try {
          const remotes = await this.options.client.remotes(paths);
          if (!remotes.some((remote) => remote.id === input.remoteVaultId))
            throw nativeFailure('OBSIDIAN_SETUP_FAILED');
          // Explicit setup/reset is the only action allowed to recreate a lost checkout.
          // Remove BOTH sync state and checkout while no process can start.
          await rm(join(clientStateRoot(paths), 'sync'), { recursive: true, force: true });
          await rm(paths.vault, { recursive: true, force: true });
          await mkdir(paths.vault, { mode: 0o700 });
          await this.options.client.setup(paths, input);
          await this.patch(vault, {
            remoteVaultId: input.remoteVaultId,
            mode: input.mode,
            enabled: true,
            phase: 'initial-sync',
            hasSynced: false,
            lastErrorCode: null,
          });
          this.launch(vault);
        } catch (error) {
          const failure =
            error instanceof ApiFailure ? error : nativeFailure('OBSIDIAN_SETUP_FAILED');
          await this.patch(vault, { enabled: false, phase: 'error', lastErrorCode: failure.code });
          throw failure;
        }
      }),
    );
  }
  async enable(vault: Vault, enabled: boolean): Promise<void> {
    this.assertOpen(vault);
    return this.controls.run('capacity', () =>
      this.controls.run(vault.id, async () => {
        this.assertOpen(vault);
        if (enabled) {
          await this.capacity(vault);
          if (!(await this.status(vault)).remoteVaultId)
            throw nativeFailure('OBSIDIAN_SETUP_FAILED');
        }
        await this.patch(vault, {
          enabled,
          phase: enabled ? 'initial-sync' : 'stopped',
          lastErrorCode: null,
        });
        await this.stop(vault);
        await this.patch(vault, {
          enabled,
          phase: enabled ? 'initial-sync' : 'stopped',
          lastErrorCode: null,
        });
        if (enabled) this.launch(vault);
      }),
    );
  }
  private launch(vault: Vault): void {
    if (this.closing || this.deleting.has(vault.id) || this.workers.has(vault.id)) return;
    const controller = new AbortController();
    const worker: Worker = { controller, done: Promise.resolve() };
    this.workers.set(vault.id, worker);
    worker.done = this.supervise(vault, controller.signal)
      .catch(() => undefined)
      .finally(() => {
        if (this.workers.get(vault.id) === worker) this.workers.delete(vault.id);
      });
  }
  private async preflight(
    vault: Vault,
    state: ObsidianSyncSettings,
    paths: VaultPaths,
  ): Promise<void> {
    try {
      await safeDirectory(paths.vault);
      const stateRoot = clientStateRoot(paths);
      const syncDirs = await readdir(join(stateRoot, 'sync'));
      if (syncDirs.length === 0) throw nativeFailure('OBSIDIAN_CHECKOUT_MISSING');
      // A checkout that lost all visible files while retaining a nonempty ledger
      // must not be interpreted by the official client as user deletions.
      if (
        state.hasSynced &&
        (await this.dependencies.database.vaultFiles.listByVault(vault.id)).length > 0 &&
        (await readdir(paths.vault)).filter((name) => !name.startsWith('.')).length === 0
      )
        throw nativeFailure('OBSIDIAN_CHECKOUT_MISSING');
      if (state.hasSynced) {
        for (const file of await this.dependencies.database.vaultFiles.listByVault(vault.id)) {
          const destination = await confinedPath(paths.vault, file.path);
          const info = await lstat(destination);
          if (!info.isFile()) throw nativeFailure('OBSIDIAN_CHECKOUT_MISSING');
        }
      }
      const token = await lstat(join(stateRoot, 'auth_token'));
      if (!token.isFile() || token.isSymbolicLink()) throw nativeFailure('OBSIDIAN_AUTH_EXPIRED');
    } catch (error) {
      throw error instanceof ApiFailure ? error : nativeFailure('OBSIDIAN_CHECKOUT_MISSING');
    }
  }
  private async supervise(vault: Vault, signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted && !this.closing) {
      const settings = await this.status(vault);
      if (!settings.enabled || !settings.remoteVaultId) return;
      try {
        const paths = await this.privatePaths(vault);
        await this.preflight(vault, settings, paths);
        await this.patch(vault, { phase: 'installing', lastErrorCode: null });
        await this.options.client.ensure();
        if (signal.aborted) return;
        await this.options.client.configure(paths, settings.mode);
        await this.patch(vault, { phase: 'initial-sync' });
        await this.options.client.sync(paths, false, signal);
        if (signal.aborted) return;
        await this.contents.run(vault.id, () => importCheckout(this.dependencies, vault, paths));
        if (signal.aborted) return;
        await this.patch(vault, {
          phase: 'running',
          hasSynced: true,
          lastSyncedAt: this.dependencies.clock.now(),
        });
        const started = Date.now();
        try {
          await this.continuous(vault, paths, signal);
        } finally {
          if (Date.now() - started > 60_000) failures = 0;
        }
        if (!signal.aborted) throw nativeFailure('OBSIDIAN_SYNC_FAILED');
      } catch (error) {
        if (signal.aborted || this.closing) return;
        const failure = error instanceof ApiFailure ? error : nativeFailure('OBSIDIAN_SYNC_FAILED');
        await this.patch(vault, { phase: 'error', lastErrorCode: failure.code });
        if (
          failure.code === 'OBSIDIAN_CHECKOUT_MISSING' ||
          failure.code === 'OBSIDIAN_AUTH_EXPIRED' ||
          failure.code === 'OBSIDIAN_SETUP_FAILED'
        )
          return;
        failures++;
        // Persist enabled=true so a reboot or manual Retry can recover installations.
        await delay(
          Math.min(
            300_000,
            (this.options.retryIntervalMs ?? 2_000) * 2 ** Math.min(failures - 1, 8),
          ),
          undefined,
          { signal },
        ).catch(() => undefined);
      }
    }
  }
  private async continuous(vault: Vault, paths: VaultPaths, parent: AbortSignal): Promise<void> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    parent.addEventListener('abort', abort, { once: true });
    if (parent.aborted) controller.abort();
    let dirty = true;
    let lastScan = Date.now();
    let fallback = false;
    let watcher: FSWatcher | undefined;
    try {
      watcher = watch(paths.vault, { recursive: true }, (_event, path) => {
        if (!path || visibleVaultPath(path.replaceAll('\\', '/'))) dirty = true;
      });
      watcher.on('error', () => {
        fallback = true;
        dirty = true;
      });
    } catch {
      fallback = true;
    }
    let ended = false;
    let failure: unknown;
    const child = this.options.client
      .sync(paths, true, controller.signal)
      .catch((error) => {
        failure = error;
      })
      .finally(() => {
        ended = true;
        controller.abort();
      });
    try {
      while (!controller.signal.aborted && !ended) {
        await delay(this.options.scanIntervalMs ?? 2_000, undefined, { signal: controller.signal });
        if (controller.signal.aborted || ended) break;
        if (!dirty && !fallback && Date.now() - lastScan < 60_000) continue;
        dirty = false;
        lastScan = Date.now();
        await this.contents.run(vault.id, () => importCheckout(this.dependencies, vault, paths));
        await this.patch(vault, { lastSyncedAt: this.dependencies.clock.now() });
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      watcher?.close();
      controller.abort();
      await child;
      parent.removeEventListener('abort', abort);
    }
    if (!parent.aborted) throw failure ?? nativeFailure('OBSIDIAN_SYNC_FAILED');
  }
  async writeNote(
    vault: Vault,
    plan: Parameters<ObsidianSyncService['writeNote']>[1],
    text: string,
  ) {
    this.assertOpen(vault);
    const bytes = new TextEncoder().encode(text);
    if (bytes.byteLength > (this.dependencies.maxBlobBytes ?? DEFAULT_BLOB_LIMIT))
      fail(413, 'BLOB_TOO_LARGE', 'Content exceeds the configured size limit.');
    return this.controls.run(vault.id, async () => {
      this.assertOpen(vault);
      const state = await this.status(vault);
      if (state.mode !== 'bidirectional')
        fail(
          409,
          'OBSIDIAN_READ_ONLY',
          'This vault downloads from Obsidian Sync. Edit it in Obsidian.',
        );
      if (!state.enabled || !state.hasSynced || state.phase !== 'running')
        fail(409, 'OBSIDIAN_SYNC_FAILED', 'Wait for Obsidian Sync to be running before editing.');
      await this.stop(vault);
      try {
        return await this.contents.run(vault.id, async () => {
          const paths = this.paths(vault);
          await this.preflight(vault, state, paths);
          await importCheckout(this.dependencies, vault, paths);
          const current =
            plan.kind === 'update'
              ? await this.dependencies.database.vaultFiles.findById(vault.id, plan.fileId)
              : await this.dependencies.database.vaultFiles.findByPath(vault.id, plan.path);
          if (plan.kind === 'create' && current) return { status: 'exists' as const, current };
          if (plan.kind === 'update' && !current)
            fail(404, 'VAULT_NOT_FOUND', 'File was not found.');
          if (plan.kind === 'update' && current && current.blobHash !== plan.baseHash)
            return { status: 'conflict' as const, current };
          if (current && current.kind !== 'markdown')
            fail(400, 'INVALID_MANIFEST', 'Only Markdown notes can be edited.');
          const fresh = await this.dependencies.database.vaults.findById(vault.id);
          if (current && current.blobHash === (await sha256Hex(bytes)))
            return {
              status: 'up-to-date' as const,
              revision: fresh!.latestRevision,
              file: current,
            };
          const path = plan.kind === 'create' ? plan.path : current!.path;
          if (!/\.md$/i.test(path)) fail(400, 'INVALID_PATH', 'Markdown notes must end in .md.');
          await atomicNoteWrite(paths, path, bytes);
          const revision = await importCheckout(this.dependencies, vault, paths);
          const file = await this.dependencies.database.vaultFiles.findByPath(vault.id, path);
          if (!file) throw nativeFailure('OBSIDIAN_SYNC_FAILED');
          return { status: 'committed' as const, revision, file };
        });
      } catch (error) {
        throw error instanceof ApiFailure ? error : nativeFailure('OBSIDIAN_SYNC_FAILED');
      } finally {
        this.launch(vault);
      }
    });
  }
  async remove(vault: Vault): Promise<void> {
    this.deleting.add(vault.id);
    return this.controls.run(vault.id, async () => {
      await this.patch(vault, { enabled: false, phase: 'stopped' });
      await this.stop(vault);
      const paths = this.paths(vault);
      // Child is gone, so local removal cannot propagate to the remote vault.
      // Network revocation is best effort (expired credentials/offline deletion).
      await this.options.client.unlink(paths).catch(() => undefined);
      await this.options.client.logout(paths).catch(() => undefined);
      await rm(paths.root, { recursive: true, force: true });
      this.loginAttempts.delete(vault.id);
    });
  }
  async boot(): Promise<void> {
    this.assertOpen();
    let started = 0;
    for (const settings of await this.dependencies.database.obsidianSync.list()) {
      if (!settings.enabled) continue;
      const vault = await this.dependencies.database.vaults.findById(settings.vaultId);
      if (vault?.syncMode !== 'obsidian') continue;
      if (started >= (this.options.maxVaults ?? 5)) {
        await this.patch(vault, {
          enabled: false,
          phase: 'error',
          lastErrorCode: 'OBSIDIAN_SYNC_LIMIT',
        });
        continue;
      }
      started++;
      this.launch(vault);
    }
  }
  async close(): Promise<void> {
    this.closing = true;
    this.options.client.close?.();
    for (const worker of this.workers.values()) worker.controller.abort();
    await this.controls.drain();
    await Promise.allSettled([...this.workers.values()].map((worker) => worker.done));
    await this.contents.drain();
  }
}
