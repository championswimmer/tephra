import type { App } from 'obsidian';
import type { RemoteVault } from '../../api/client';
import type TephraPlugin from '../../main';

/** Transient form state that survives re-renders of the settings tab. */
export interface SettingsFormState {
  loginEmail: string;
  loginPassword: string;
  newVaultName: string;
  availableVaults: RemoteVault[];
  selectedVaultId: string;
  isFetchingVaults: boolean;
}

export interface SettingsContext {
  app: App;
  plugin: TephraPlugin;
  form: SettingsFormState;
  /** Re-render the whole settings tab. */
  refresh: () => void;
}
