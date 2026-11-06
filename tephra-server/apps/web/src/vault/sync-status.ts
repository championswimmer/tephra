import type { Vault } from '../api/types';

const STATUS_LABELS: Record<NonNullable<Vault['obsidianSync']>['phase'], string> = {
  'pending-login': 'Waiting for login',
  'pending-remote': 'Waiting for remote vault',
  installing: 'Installing',
  'initial-sync': 'Initial sync in progress',
  running: 'Running',
  stopped: 'Stopped',
  error: 'Error',
  unavailable: 'Unavailable',
};

export function syncStatus(vault: Vault): string {
  const summary = vault.obsidianSync;
  if (!summary) return 'Obsidian Sync · Status unavailable';
  const label = summary.phase === 'running' && !summary.enabled ? 'Stopped' : STATUS_LABELS[summary.phase];
  return `Obsidian Sync · ${label}`;
}

