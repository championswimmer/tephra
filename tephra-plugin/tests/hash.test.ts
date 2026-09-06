import { describe, expect, it } from 'vitest';
import { manifestHash } from '../src/sync/manifest';
import { sha256Hex } from '../src/sync/hasher';

describe('canonical hashing', () => {
  it('matches known SHA-256 vectors', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(await manifestHash([])).toBe(
      '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
    );
  });

  it('sorts before hashing using protocol canonical JSON', async () => {
    const a = {
      fileId: 'a',
      path: 'A.md',
      hash: 'a'.repeat(64),
      size: 1,
      mtime: 2,
      kind: 'markdown' as const,
    };
    const b = {
      fileId: 'b',
      path: 'B.md',
      hash: 'b'.repeat(64),
      size: 2,
      mtime: 3,
      kind: 'markdown' as const,
    };
    expect(await manifestHash([b, a])).toBe(await manifestHash([a, b]));
  });
});
