import { sha256Hex } from '../hasher';
import type { VaultFileKind } from './types';

/** NUL separator between mint inputs — see plan 010 §6. */
const MINT_SEPARATOR = String.fromCharCode(0);

/**
 * Path-seeded identity minting (plan 010, §6).
 *
 * Two devices with no shared state converge on the same ids for every file
 * that was never renamed, because the mint is a deterministic function of
 * `(vaultId, path)`. Determinism is an optimization — uniqueness is
 * correctness, so callers must fall back to {@link randomFileId} when the
 * minted id is already claimed in the current scan (recycled path).
 */
export async function mintFileId(
  vaultId: string,
  path: string,
  kind: VaultFileKind,
): Promise<string> {
  const input = vaultId + MINT_SEPARATOR + path;
  const digest = await sha256Hex(new TextEncoder().encode(input));
  const prefix = kind === 'attachment' ? 'file_attachment_' : 'file_';
  return prefix + digest.slice(0, 32);
}

export function randomFileId(): string {
  return `file_${globalThis.crypto.randomUUID()}`;
}
