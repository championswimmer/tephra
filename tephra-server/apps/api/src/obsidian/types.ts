import type { ObsidianSyncSettings, Vault } from '@tephra/vault-model';
import type { NoteCommitResult } from '../mcp/commit.js';

export interface ObsidianLogin {
  email: string;
  password: string;
  mfa?: string | undefined;
}
export interface ObsidianSetup {
  remoteVaultId: string;
  encryptionPassword?: string | undefined;
  mode: 'bidirectional' | 'pull-only';
}
export interface ObsidianRemote {
  id: string;
  name: string;
  region?: string | undefined;
}
export interface ObsidianSyncService {
  status(vault: Vault): Promise<ObsidianSyncSettings>;
  login(vault: Vault, input: ObsidianLogin): Promise<void>;
  remotes(vault: Vault): Promise<ObsidianRemote[]>;
  setup(vault: Vault, input: ObsidianSetup): Promise<void>;
  enable(vault: Vault, enabled: boolean): Promise<void>;
  remove(vault: Vault): Promise<void>;
  writeNote(
    vault: Vault,
    plan: { kind: 'create'; path: string } | { kind: 'update'; fileId: string; baseHash: string },
    text: string,
  ): Promise<NoteCommitResult>;
}

export function initialObsidianSettings(vaultId: string): ObsidianSyncSettings {
  return {
    vaultId,
    enabled: false,
    remoteVaultId: null,
    mode: 'bidirectional',
    phase: 'pending-login',
    lastErrorCode: null,
    hasSynced: false,
    lastSyncedAt: null,
  };
}
