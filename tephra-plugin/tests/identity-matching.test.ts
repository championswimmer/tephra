import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/sync/hasher';
import { mintFileId, randomFileId } from '../src/sync/identity/id-mint';
import { dedupePrevEntries, matchIdentities } from '../src/sync/identity/matcher';
import type { CurrEntry, PrevEntry } from '../src/sync/identity/types';

const VAULT = 'vlt_test';

function prevEntry(path: string, fileId: string, hash = `hash-of-${path}`): PrevEntry {
  return { path, fileId, hash };
}

function currEntry(path: string, hash = `hash-of-${path}`): CurrEntry {
  return { path, hash, size: 10, mtime: 1, kind: 'markdown' };
}

function byPath(result: Awaited<ReturnType<typeof matchIdentities>>) {
  return new Map(result.resolved.map((entry) => [entry.path, entry]));
}

describe('mintFileId', () => {
  it('is deterministic and path-seeded with a NUL separator', async () => {
    const first = await mintFileId(VAULT, 'Notes/A.md', 'markdown');
    const second = await mintFileId(VAULT, 'Notes/A.md', 'markdown');
    expect(first).toBe(second);
    expect(first.startsWith('file_')).toBe(true);

    const expected = await sha256Hex(new TextEncoder().encode(VAULT + '\0' + 'Notes/A.md'));
    expect(first).toBe(`file_${expected.slice(0, 32)}`);
  });

  it('differs by path, vault, and kind', async () => {
    const base = await mintFileId(VAULT, 'A.md', 'markdown');
    expect(await mintFileId(VAULT, 'B.md', 'markdown')).not.toBe(base);
    expect(await mintFileId('other-vault', 'A.md', 'markdown')).not.toBe(base);
    const attachment = await mintFileId(VAULT, 'A.md', 'attachment');
    expect(attachment.startsWith('file_attachment_')).toBe(true);
    expect(attachment).not.toBe(base);
  });

  it('randomFileId returns a unique file_-prefixed id', () => {
    const ids = new Set([randomFileId(), randomFileId(), randomFileId()]);
    expect(ids.size).toBe(3);
    for (const id of ids) expect(id.startsWith('file_')).toBe(true);
  });
});

describe('dedupePrevEntries', () => {
  it('keeps the code-point-lowest path when one id is bound twice', () => {
    const deduped = dedupePrevEntries([
      prevEntry('b.md', 'file_x'),
      prevEntry('a.md', 'file_x'),
      prevEntry('c.md', 'file_y'),
    ]);
    expect(deduped).toHaveLength(2);
    expect(deduped.find((entry) => entry.fileId === 'file_x')?.path).toBe('a.md');
  });
});

describe('stage 1 — exact path match', () => {
  it('keeps the id for unchanged and modified files alike', async () => {
    const result = await matchIdentities(
      [prevEntry('A.md', 'file_1', 'h1'), prevEntry('B.md', 'file_2', 'h2')],
      [currEntry('A.md', 'h1'), currEntry('B.md', 'h2-changed')],
      { vaultId: VAULT },
    );
    const map = byPath(result);
    expect(map.get('A.md')).toMatchObject({ fileId: 'file_1', origin: 'path' });
    expect(map.get('B.md')).toMatchObject({ fileId: 'file_2', origin: 'path' });
    expect(result.deletedIds).toEqual([]);
    expect(result.identityChanged).toEqual([]);
  });
});

describe('stage 0 — rename hints', () => {
  it('rebinds through a hint even when the hash changed (hint beats hash/mint)', async () => {
    const result = await matchIdentities(
      [prevEntry('A.md', 'file_1', 'h1')],
      [currEntry('B.md', 'h2-edited-after-rename')],
      { vaultId: VAULT, hints: [['A.md', 'B.md']] },
    );
    expect(byPath(result).get('B.md')).toMatchObject({ fileId: 'file_1', origin: 'hint' });
    expect(result.deletedIds).toEqual([]);
  });

  it('resolves chains A→B→C to the terminal path', async () => {
    const result = await matchIdentities(
      [prevEntry('A.md', 'file_1', 'h1')],
      [currEntry('C.md', 'h1')],
      { vaultId: VAULT, hints: [['A.md', 'B.md'], ['B.md', 'C.md']] },
    );
    expect(byPath(result).get('C.md')).toMatchObject({ fileId: 'file_1', origin: 'hint' });
    expect(result.deletedIds).toEqual([]);
  });

  it('ignores hints whose old path is unknown or whose target is taken', async () => {
    const result = await matchIdentities(
      [prevEntry('A.md', 'file_1', 'h1'), prevEntry('B.md', 'file_2', 'h2')],
      [currEntry('B.md', 'h2'), currEntry('C.md', 'h3')],
      { vaultId: VAULT, hints: [['Ghost.md', 'C.md'], ['A.md', 'B.md']] },
    );
    const map = byPath(result);
    // A.md → B.md is not rebound: B.md already has an identity.
    expect(map.get('B.md')).toMatchObject({ fileId: 'file_2', origin: 'path' });
    // C.md mints fresh; A.md's id is deleted.
    expect(map.get('C.md')?.origin).toBe('mint');
    expect(result.deletedIds).toEqual(['file_1']);
  });
});

describe('copy does not steal', () => {
  it('a copied file mints a fresh id while the original keeps its own', async () => {
    const result = await matchIdentities(
      [prevEntry('X.md', 'file_1', 'h1')],
      [currEntry('X.md', 'h1'), currEntry('Y.md', 'h1')],
      { vaultId: VAULT },
    );
    const map = byPath(result);
    expect(map.get('X.md')).toMatchObject({ fileId: 'file_1', origin: 'path' });
    const copy = map.get('Y.md');
    expect(copy?.origin).toBe('mint');
    expect(copy?.fileId).not.toBe('file_1');
    expect(result.deletedIds).toEqual([]);
  });
});

describe('stage 1b — frontmatter ids', () => {
  it('beats hash matching: a residual carrying an unclaimed frontmatter id adopts it', async () => {
    const result = await matchIdentities(
      [prevEntry('P.md', 'file_9', 'h9')],
      [currEntry('Q.md', 'h9')],
      { vaultId: VAULT, frontmatterIds: new Map([['Q.md', 'file_fm']]) },
    );
    expect(byPath(result).get('Q.md')).toMatchObject({
      fileId: 'file_fm',
      origin: 'frontmatter',
    });
    expect(result.deletedIds).toEqual(['file_9']);
  });

  it('an already-claimed frontmatter id falls through to mint', async () => {
    const result = await matchIdentities(
      [prevEntry('P.md', 'file_1', 'h1')],
      [currEntry('P.md', 'h1'), currEntry('Q.md', 'h2')],
      { vaultId: VAULT, frontmatterIds: new Map([['Q.md', 'file_1']]) },
    );
    const map = byPath(result);
    expect(map.get('P.md')).toMatchObject({ fileId: 'file_1', origin: 'path' });
    expect(map.get('Q.md')?.origin).toBe('mint');
    expect(map.get('Q.md')?.fileId).not.toBe('file_1');
  });

  it('duplicate frontmatter ids: code-point-lowest claimant wins, loser mints', async () => {
    const result = await matchIdentities(
      [],
      [currEntry('b.md', 'h1'), currEntry('a.md', 'h1')],
      { vaultId: VAULT, frontmatterIds: new Map([['a.md', 'file_fm'], ['b.md', 'file_fm']]) },
    );
    const map = byPath(result);
    expect(map.get('a.md')).toMatchObject({ fileId: 'file_fm', origin: 'frontmatter' });
    expect(map.get('b.md')?.origin).toBe('mint');
    const ids = new Set(result.resolved.map((entry) => entry.fileId));
    expect(ids.size).toBe(2);
  });
});

describe('stage 2 — hash rename detection', () => {
  it('pairs residuals positionally by code-point-sorted path', async () => {
    const result = await matchIdentities(
      [prevEntry('old-b.md', 'file_2', 'h'), prevEntry('old-a.md', 'file_1', 'h')],
      [currEntry('new-b.md', 'h'), currEntry('new-a.md', 'h')],
      { vaultId: VAULT },
    );
    const map = byPath(result);
    // old-a ↔ new-a, old-b ↔ new-b (sorted pairing, not insertion order).
    expect(map.get('new-a.md')).toMatchObject({ fileId: 'file_1', origin: 'hash' });
    expect(map.get('new-b.md')).toMatchObject({ fileId: 'file_2', origin: 'hash' });
    expect(result.deletedIds).toEqual([]);
  });

  it('N byte-identical files renamed at once: deterministic and unique', async () => {
    const count = 20;
    const prev = Array.from({ length: count }, (_, i) => prevEntry(`old-${i}.md`, `file_${i}`, 'same'));
    const curr = Array.from({ length: count }, (_, i) => currEntry(`new-${i}.md`, 'same'));
    const first = await matchIdentities(prev, curr, { vaultId: VAULT });
    const second = await matchIdentities(prev, curr, { vaultId: VAULT });
    expect(first.resolved).toEqual(second.resolved);
    const ids = new Set(first.resolved.map((entry) => entry.fileId));
    expect(ids.size).toBe(count);
    // Positional: old-0 ↔ new-0 … (code-point order is lexicographic: old-0, old-1, old-10, …).
    const sortedPrev = [...prev].sort((a, b) => (a.path < b.path ? -1 : 1));
    const sortedCurr = [...first.resolved].sort((a, b) => (a.path < b.path ? -1 : 1));
    sortedPrev.forEach((entry, index) => {
      expect(sortedCurr[index]?.fileId ?? 'missing').toBe(entry.fileId);
    });
    expect(first.deletedIds).toEqual([]);
  });

  it('surplus prev entries become deletions; surplus curr entries mint', async () => {
    const result = await matchIdentities(
      [prevEntry('gone-a.md', 'file_1', 'h'), prevEntry('gone-b.md', 'file_2', 'h')],
      [currEntry('only.md', 'h')],
      { vaultId: VAULT },
    );
    // Sorted pairing: gone-a ↔ only.md; gone-b is the leftover deletion.
    expect(byPath(result).get('only.md')).toMatchObject({ fileId: 'file_1', origin: 'hash' });
    expect(result.deletedIds).toEqual(['file_2']);
  });
});

describe('stage 3 — rename + edit is unresolvable', () => {
  it('path changed and hash changed with no hint: delete + mint', async () => {
    const result = await matchIdentities(
      [prevEntry('A.md', 'file_1', 'h1')],
      [currEntry('B.md', 'h2')],
      { vaultId: VAULT },
    );
    expect(byPath(result).get('B.md')?.origin).toBe('mint');
    expect(byPath(result).get('B.md')?.fileId).not.toBe('file_1');
    expect(result.deletedIds).toEqual(['file_1']);
  });
});

describe('stage 4 — minting and collisions', () => {
  it('a recycled path falls back to a random id instead of duplicating', async () => {
    // B.md was renamed from A.md and kept H(A); a *new* A.md would mint H(A).
    const recycled = await mintFileId(VAULT, 'A.md', 'markdown');
    const result = await matchIdentities(
      [prevEntry('B.md', recycled, 'h-other')],
      [currEntry('B.md', 'h-other'), currEntry('A.md', 'h-brand-new')],
      { vaultId: VAULT },
    );
    const map = byPath(result);
    expect(map.get('B.md')).toMatchObject({ fileId: recycled, origin: 'path' });
    expect(map.get('A.md')?.origin).toBe('mint');
    expect(map.get('A.md')?.fileId).not.toBe(recycled);
    const ids = new Set(result.resolved.map((entry) => entry.fileId));
    expect(ids.size).toBe(2);
  });

  it('claimedExtra ids are avoided when minting', async () => {
    const taken = await mintFileId(VAULT, 'New.md', 'markdown');
    const result = await matchIdentities([], [currEntry('New.md', 'h')], {
      vaultId: VAULT,
      claimedExtra: new Set([taken]),
    });
    expect(byPath(result).get('New.md')?.fileId).not.toBe(taken);
  });
});

describe('identityChanged', () => {
  it('flags surviving paths whose id differs (corrupt sidecar dedupe casualty)', async () => {
    // b.md loses the duplicated id to a.md in dedupe, then mints fresh.
    const result = await matchIdentities(
      [
        { path: 'b.md', fileId: 'file_x', hash: 'hb' },
        { path: 'a.md', fileId: 'file_x', hash: 'ha' },
      ],
      [currEntry('a.md', 'ha'), currEntry('b.md', 'hb')],
      { vaultId: VAULT },
    );
    const map = byPath(result);
    expect(map.get('a.md')).toMatchObject({ fileId: 'file_x', origin: 'path' });
    expect(map.get('b.md')?.fileId).not.toBe('file_x');
    expect(result.identityChanged).toEqual(['b.md']);
  });
});

/** Deterministic PRNG so the property test is reproducible. */
function mulberry32(seed: number) {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('property: structural invariants over randomized prev/curr', () => {
  it.each([1, 2, 3, 4, 5])('seed %i: one entry per path, no duplicate ids', async (seed) => {
    const rand = mulberry32(seed);
    const pick = (n: number) => Math.floor(rand() * n);
    const hashes = ['h0', 'h1', 'h2', 'h3', 'h4'];
    const pickHash = (): string => hashes[pick(hashes.length)] ?? 'h0';

    const prev: PrevEntry[] = [];
    for (let i = 0; i < 120; i += 1) {
      // Occasional duplicate ids exercise the loader-dedupe path.
      const fileId = rand() < 0.08 ? `file_${pick(10)}` : `file_${i}`;
      prev.push({ path: `note-${i}.md`, fileId, hash: pickHash() });
    }
    const surviving = prev.filter(() => rand() < 0.6).map((e) => e.path);
    const curr: CurrEntry[] = surviving.map((path) => ({
      path,
      hash: rand() < 0.8 ? (prev.find((e) => e.path === path)?.hash ?? 'h0') : 'edited',
      size: 5,
      mtime: 2,
      kind: 'markdown' as const,
    }));
    for (let i = 0; i < 40; i += 1) {
      curr.push({ path: `new-${seed}-${i}.md`, hash: pickHash(), size: 5, mtime: 2, kind: 'markdown' });
    }
    const hints: Array<[string, string]> = [];
    for (let i = 0; i < 10; i += 1) {
      hints.push([`note-${pick(120)}.md`, `renamed-${seed}-${i}.md`]);
      curr.push({ path: `renamed-${seed}-${i}.md`, hash: pickHash(), size: 5, mtime: 2, kind: 'markdown' });
    }

    const result = await matchIdentities(prev, curr, { vaultId: VAULT, hints });

    const uniqueCurrPaths = new Set(curr.map((e) => e.path));
    expect(result.resolved).toHaveLength(uniqueCurrPaths.size);
    for (const path of uniqueCurrPaths) {
      expect(result.resolved.filter((e) => e.path === path)).toHaveLength(1);
    }
    const ids = result.resolved.map((e) => e.fileId);
    expect(new Set(ids).size).toBe(ids.length);
    const resolvedIds = new Set(ids);
    for (const deleted of result.deletedIds) expect(resolvedIds.has(deleted)).toBe(false);
    const prevPaths = new Set(prev.map((e) => e.path));
    for (const changed of result.identityChanged) {
      expect(prevPaths.has(changed)).toBe(true);
      expect(uniqueCurrPaths.has(changed)).toBe(true);
    }
  });
});

describe('performance', () => {
  it('matches 50k unchanged files in well under 2s', async () => {
    const count = 50_000;
    const prev: PrevEntry[] = Array.from({ length: count }, (_, i) => ({
      path: `folder/note-${i}.md`,
      fileId: `file_${i}`,
      hash: 'h',
    }));
    const curr: CurrEntry[] = Array.from({ length: count }, (_, i) => ({
      path: `folder/note-${i}.md`,
      hash: 'h',
      size: 1,
      mtime: 1,
      kind: 'markdown',
    }));
    const started = Date.now();
    const result = await matchIdentities(prev, curr, { vaultId: VAULT });
    const elapsed = Date.now() - started;
    expect(result.resolved).toHaveLength(count);
    expect(result.deletedIds).toEqual([]);
    expect(result.resolved.every((e) => e.origin === 'path')).toBe(true);
    expect(elapsed).toBeLessThan(2000);
  }, 30_000);
});
