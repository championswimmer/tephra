import type { SyncManifestEntry } from '@tephra/protocol';

export interface TephraSettings {
  serverUrl: string;
  vaultId: string;
  uploadToken: string;
  deviceId: string;
  deviceName: string;
  debounceMs: number;
  concurrency: number;
}

export type LocalFileState = SyncManifestEntry;

export interface TephraPluginState {
  version: 1;
  settings: TephraSettings;
  manifest: Record<string, LocalFileState>;
  attachmentIds: Record<string, string>;
  lastSuccessfulSyncAt?: number;
  lastRemoteRevision?: number;
}

export const DEFAULT_SETTINGS: TephraSettings = {
  serverUrl: '',
  vaultId: '',
  uploadToken: '',
  deviceId: '',
  deviceName: 'Obsidian',
  debounceMs: 2_000,
  concurrency: 3,
};

export function defaultState(): TephraPluginState {
  return { version: 1, settings: { ...DEFAULT_SETTINGS }, manifest: {}, attachmentIds: {} };
}

export function parseState(value: unknown): TephraPluginState {
  const defaults = defaultState();
  if (!value || typeof value !== 'object') return defaults;
  const input = value as Partial<TephraPluginState>;
  const settings = input.settings && typeof input.settings === 'object' ? input.settings : {};
  return {
    ...defaults,
    ...input,
    version: 1,
    settings: { ...defaults.settings, ...settings },
    manifest: input.manifest ?? {},
    attachmentIds: input.attachmentIds ?? {},
  };
}
