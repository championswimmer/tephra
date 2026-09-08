import { describe, expect, it } from 'vitest';
import { createVaultPathIndex, isAttachmentEmbed, resolveLink } from '../src/index.js';

const index = createVaultPathIndex([
  { fileId: 'root-project', path: 'Project.md', kind: 'markdown' },
  { fileId: 'one-note', path: 'One/Note.md', kind: 'markdown' },
  { fileId: 'two-note', path: 'Two/Note.md', kind: 'markdown' },
  { fileId: 'other', path: 'Two/Other Note.md', kind: 'markdown' },
  { fileId: 'image', path: 'Assets/my image.png', kind: 'attachment' },
]);

describe('resolveLink', () => {
  it('prefers exact vault paths and accepts omitted Markdown extensions', () => {
    expect(resolveLink('One/Source.md', 'Project', index)).toMatchObject({ status: 'resolved', targetFileId: 'root-project' });
    expect(resolveLink('Source.md', 'Two/Note.md', index)).toMatchObject({ status: 'resolved', targetFileId: 'two-note' });
  });

  it('resolves paths relative to the source folder before basename fallback', () => {
    expect(resolveLink('One/Source.md', 'Note', index)).toMatchObject({ status: 'resolved', targetFileId: 'one-note' });
  });

  it('uses folder proximity and reports equally ranked duplicate basenames as ambiguous', () => {
    expect(resolveLink('One/Subfolder/Source.md', 'Note', index)).toMatchObject({ status: 'resolved', targetFileId: 'one-note' });
    const resolution = resolveLink('Elsewhere/Source.md', 'Note', index);
    expect(resolution).toMatchObject({ status: 'ambiguous', targetFileId: null, unresolved: true, ambiguous: true });
    expect(resolution.candidates).toEqual(['One/Note.md', 'Two/Note.md']);
  });

  it('decodes URL paths and preserves heading and block subpaths', () => {
    expect(resolveLink('One/Source.md', 'Two/Other%20Note.md#Heading%20One', index)).toMatchObject({ targetFileId: 'other', subpath: 'Heading One' });
    expect(resolveLink('One/Source.md', 'Project#%5Eblock-1', index)).toMatchObject({ targetFileId: 'root-project', subpath: '^block-1' });
  });

  it('distinguishes unresolved links and attachment embeds', () => {
    expect(resolveLink('One/Source.md', 'Missing', index)).toMatchObject({ status: 'unresolved', targetFileId: null });
    const attachment = resolveLink('One/Source.md', 'Assets/my%20image.png', index);
    expect(isAttachmentEmbed({ isEmbed: true, resolution: attachment })).toBe(true);
  });

  it('resolves across Unicode normalization forms (NFD-stored path, NFC wikilink)', () => {
    // macOS hands out NFD filenames while wikilinks are typically typed in
    // NFC. Ingest canonicalizes to NFC, but resolution must also tolerate a
    // non-canonical stored path so one drifted entry cannot break the graph.
    const nfdStored = 'Cafe\u0301.md'; // NFD "Café.md"
    const nfcLink = 'Caf\u00e9'; // NFC "Café"
    const drifted = createVaultPathIndex([
      { fileId: 'cafe', path: nfdStored, kind: 'markdown' },
    ]);
    expect(resolveLink('Source.md', nfcLink, drifted)).toMatchObject({
      status: 'resolved',
      targetFileId: 'cafe',
    });
    // And symmetrically: an NFC-stored path resolves an NFD-typed link.
    const nfcStored = createVaultPathIndex([
      { fileId: 'cafe', path: 'Caf\u00e9.md', kind: 'markdown' },
    ]);
    expect(resolveLink('Source.md', 'Cafe\u0301', nfcStored)).toMatchObject({
      status: 'resolved',
      targetFileId: 'cafe',
    });
  });
});
