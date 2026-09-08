import { describe, expect, it } from 'vitest';
import {
  decodeHashToPath,
  encodePathForHash,
  hashForPath,
  parseHashView,
} from '../src/vault/path-url';

describe('path-url hash helpers', () => {
  it('encodes per segment, keeping slashes literal', () => {
    expect(encodePathForHash('Notes/Target Note.md')).toBe('Notes/Target%20Note.md');
    expect(encodePathForHash('a#b?c%.md')).toBe('a%23b%3Fc%25.md');
    expect(encodePathForHash('Café/naïve.md')).toBe('Caf%C3%A9/na%C3%AFve.md');
  });

  it('NFC-normalizes before encoding', () => {
    const nfd = 'Café.md'.normalize('NFD');
    expect(nfd).not.toBe(nfd.normalize('NFC'));
    expect(encodePathForHash(nfd)).toBe(encodePathForHash(nfd.normalize('NFC')));
  });

  it('round-trips through the hash', () => {
    for (const path of ['Home.md', 'Notes/Target Note.md', 'a#b/[brackets] (x).md', 'Café.md']) {
      expect(decodeHashToPath(hashForPath(path))).toBe(path.normalize('NFC'));
    }
  });

  it('treats empty hashes as no path', () => {
    expect(decodeHashToPath('')).toBeUndefined();
    expect(decodeHashToPath('#')).toBeUndefined();
    expect(decodeHashToPath('#/')).toBeUndefined();
  });

  it('rejects malformed escapes', () => {
    expect(decodeHashToPath('#/%E0%A4%A')).toBeUndefined();
  });

  it('parses vault-level views from the splat and notes from the hash', () => {
    expect(parseHashView(undefined, '')).toEqual({ type: 'home' });
    expect(parseHashView('', '#/Home.md')).toEqual({ type: 'file', path: 'Home.md' });
    expect(parseHashView('graph', '#/Home.md')).toEqual({ type: 'graph' });
    expect(parseHashView('tokens', '')).toEqual({ type: 'tokens' });
    expect(parseHashView(undefined, '#/Notes/Target%20Note.md')).toEqual({
      type: 'file',
      path: 'Notes/Target Note.md',
    });
  });
});
