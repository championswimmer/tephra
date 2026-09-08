import type { SyncManifestEntry } from '@tephra/protocol';

export interface TephraAuthSession {
  sessionToken: string;
  userId: string;
  userEmail: string;
}

export type IdentityMode = 'frontmatter' | 'sidecar' | 'path';

export interface TephraSettings {
  serverUrl: string;
  vaultId: string;
  vaultName?: string | undefined;
  uploadToken: string;
  deviceId: string;
  deviceName: string;
  debounceMs: number;
  concurrency: number;
  enableSync: boolean;
  identityMode: IdentityMode;
  auth?: TephraAuthSession | undefined;
}

export type LocalFileState = SyncManifestEntry;

export interface TephraPluginState {
  version: 1;
  settings: TephraSettings;
  manifest: Record<string, LocalFileState>;
  /** mtime+size fast path and hash source for rename detection (plan 010, §7.4). */
  scanCache: Record<string, { hash: string; size: number; mtime: number }>;
  /** Durable rename hints, cleared on commit (plan 010, §7.4). */
  pendingRenames: [string, string][];
  identityRepairNeeded?: boolean | undefined;
  lastSuccessfulSyncAt?: number | undefined;
  lastRemoteRevision?: number | undefined;
}

export const DEFAULT_SETTINGS: TephraSettings = {
  serverUrl: '',
  vaultId: '',
  vaultName: '',
  uploadToken: '',
  deviceId: '',
  deviceName: 'Obsidian',
  debounceMs: 2_000,
  concurrency: 3,
  enableSync: true,
  identityMode: 'sidecar',
};

export function defaultState(): TephraPluginState {
  return { version: 1, settings: { ...DEFAULT_SETTINGS }, manifest: {}, scanCache: {}, pendingRenames: [] };
}

export function parseState(value: unknown): TephraPluginState {
  const defaults = defaultState();
  if (!value || typeof value !== 'object') return defaults;
  const input = value as Partial<TephraPluginState>;
  const rawSettings =
    input.settings && typeof input.settings === 'object'
      ? (input.settings as Partial<TephraSettings>)
      : {};
  return {
    ...defaults,
    ...input,
    version: 1,
    settings: {
      ...defaults.settings,
      ...rawSettings,
      enableSync:
        typeof rawSettings.enableSync === 'boolean'
          ? rawSettings.enableSync
          : defaults.settings.enableSync,
      identityMode:
        rawSettings.identityMode === 'frontmatter' ||
        rawSettings.identityMode === 'sidecar' ||
        rawSettings.identityMode === 'path'
          ? rawSettings.identityMode
          : defaults.settings.identityMode,
    },
    manifest: input.manifest ?? {},
    scanCache: input.scanCache ?? {},
    pendingRenames: input.pendingRenames ?? [],
    // NOTE: `attachmentIds` from older states is dropped outright (plan 010,
    // §7.4) — attachments resolve through the sidecar like every other file,
    // and a stale local state is repaired from the server (§9.3).
  };
}
