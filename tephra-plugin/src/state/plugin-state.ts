import type { SyncManifestEntry } from '@tephra/protocol';

export interface TephraAuthSession {
  sessionToken: string;
  userId: string;
  userEmail: string;
}

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
  auth?: TephraAuthSession | undefined;
}

export type LocalFileState = SyncManifestEntry;

export interface TephraPluginState {
  version: 1;
  settings: TephraSettings;
  manifest: Record<string, LocalFileState>;
  attachmentIds: Record<string, string>;
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
};

export function defaultState(): TephraPluginState {
  return { version: 1, settings: { ...DEFAULT_SETTINGS }, manifest: {}, attachmentIds: {} };
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
    },
    manifest: input.manifest ?? {},
    attachmentIds: input.attachmentIds ?? {},
  };
}
