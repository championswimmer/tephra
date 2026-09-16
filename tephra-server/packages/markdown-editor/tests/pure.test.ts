import { describe, expect, it } from 'vitest';

import { resolveConflict } from '../src/pure';

describe('resolveConflict', () => {
  it('returns identical when hashes match, regardless of mtimes', () => {
    expect(
      resolveConflict({ localHash: 'abc', localMtime: 100, remoteHash: 'abc', remoteMtime: 200 }),
    ).toBe('identical');
    expect(
      resolveConflict({ localHash: 'abc', localMtime: 200, remoteHash: 'abc', remoteMtime: 100 }),
    ).toBe('identical');
  });

  it('returns remote-wins when the remote side is newer', () => {
    expect(
      resolveConflict({ localHash: 'a', localMtime: 100, remoteHash: 'b', remoteMtime: 101 }),
    ).toBe('remote-wins');
  });

  it('returns local-wins when the local side is newer', () => {
    expect(
      resolveConflict({ localHash: 'a', localMtime: 101, remoteHash: 'b', remoteMtime: 100 }),
    ).toBe('local-wins');
  });

  it('resolves exact mtime ties to local (source of truth + clock skew)', () => {
    expect(
      resolveConflict({ localHash: 'a', localMtime: 100, remoteHash: 'b', remoteMtime: 100 }),
    ).toBe('local-wins');
  });
});
