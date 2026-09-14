import { describe, expect, it } from 'vitest';

import { sameIdSet } from '../src/renderer';

/** Old implementation, kept as the parity oracle for these tests. */
function legacySignature(ids: string[]): string {
  return `${ids.length}:${ids.join('\n')}`;
}

function legacySame(prev: string[] | null, next: string[]): boolean {
  if (prev === null) return false;
  return legacySignature(prev) === legacySignature(next);
}

describe('sameIdSet', () => {
  it('returns false for the first load (null previous)', () => {
    expect(sameIdSet(null, ['a', 'b'])).toBe(false);
    expect(sameIdSet(null, [])).toBe(false);
  });

  it('detects identical id arrays as unchanged', () => {
    expect(sameIdSet(['a', 'b', 'c'], ['a', 'b', 'c'])).toBe(true);
    expect(sameIdSet([], [])).toBe(true);
  });

  it('detects length changes', () => {
    expect(sameIdSet(['a', 'b'], ['a', 'b', 'c'])).toBe(false);
    expect(sameIdSet(['a', 'b', 'c'], ['a', 'b'])).toBe(false);
  });

  it('detects reorder as changed (order-sensitive, like the old signature)', () => {
    expect(sameIdSet(['a', 'b', 'c'], ['c', 'b', 'a'])).toBe(false);
    expect(sameIdSet(['a', 'b'], ['b', 'a'])).toBe(false);
  });

  it('detects single-id substitution', () => {
    expect(sameIdSet(['a', 'b', 'c'], ['a', 'x', 'c'])).toBe(false);
  });

  it('treats the old newline-join collision as changed (strictly more correct)', () => {
    // The legacy signature maps both sides to the same string and wrongly
    // reports "unchanged". File ids never contain newlines in practice,
    // so this only removes a false negative.
    expect(sameIdSet(['a\nb', 'c'], ['a', 'b\nc'])).toBe(false);
  });

  it('matches the legacy mega-string verdict on every case above and on fuzz', () => {
    const cases: Array<[string[] | null, string[]]> = [
      [null, []],
      [null, ['a']],
      [[], []],
      [['a'], ['a']],
      [['a'], ['b']],
      [['a', 'b'], ['a', 'b']],
      [['a', 'b'], ['b', 'a']],
      [['a', 'b', 'c'], ['a', 'b', 'c', 'd']],
      // Ids containing the old join separator must not confuse the compare.
      [['a\nb', 'c'], ['a\nb', 'c']],
      [['1:a', '2:b'], ['1:a', '2:b']],
    ];
    // Deterministic pseudo-random fuzz over a small id alphabet.
    let state = 42;
    const rand = (): number => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state;
    };
    const alphabet = ['a', 'b', 'c', 'x\ny', '1:2'];
    for (let i = 0; i < 200; i += 1) {
      const lenA = rand() % 5;
      const lenB = rand() % 5;
      const a = Array.from({ length: lenA }, () => alphabet[rand() % alphabet.length]!);
      const b = Array.from({ length: lenB }, () => alphabet[rand() % alphabet.length]!);
      cases.push([a, b]);
    }
    for (const [prev, next] of cases) {
      expect(sameIdSet(prev, next), `prev=${JSON.stringify(prev)} next=${JSON.stringify(next)}`).toBe(
        legacySame(prev, next),
      );
    }
  });
});
