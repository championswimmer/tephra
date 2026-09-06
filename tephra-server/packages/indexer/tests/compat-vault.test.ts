import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseNote } from '@tephra/markdown';
import type { CurrentVaultFile, NoteLink } from '@tephra/vault-model';
import { buildGraph, buildIndexRows } from '../src/index.js';

const vaultDir = fileURLToPath(new URL('../../test-fixtures/vault/', import.meta.url));

/** Full expected vault contents: legacy files plus the Stage 1 compatibility cases. */
const expectedFiles = [
  'Home.md',
  'Root.md',
  'Simple.md',
  'Folders/Alpha.md',
  'Folders/Beta.md',
  'Duplicate/A/Shared.md',
  'Duplicate/B/Shared.md',
  'Links/Aliases.md',
  'Links/Blocks.md',
  'Links/Embeds.md',
  'Links/Headings.md',
  'Links/Unresolved.md',
  'Markdown/Callouts.md',
  'Markdown/Code.md',
  'Markdown/Frontmatter.md',
  'Markdown/Math.md',
  'Markdown/Tables.md',
  'Markdown/Tags.md',
  'Markdown/Tasks.md',
  'Notes/Project Alpha.md',
  'Notes/Referenced Note.md',
  'Notes/Unresolved Links.md',
  'Unicode/Café.md',
  'Unicode/日本語.md',
  'Unicode/Spaces in name.md',
  'Attachments/image.png',
  'Attachments/pixel.png',
  'Attachments/sample.pdf',
];

function listVaultFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...listVaultFiles(absolute));
    else if (entry.isFile()) found.push(relative(vaultDir, absolute).split('\\').join('/'));
  }
  return found;
}

function loadFixtureVault(): {
  files: CurrentVaultFile[];
  notes: Array<{ fileId: string; parsed: ReturnType<typeof parseNote> }>;
} {
  const paths = listVaultFiles(vaultDir).sort();
  const files: CurrentVaultFile[] = [];
  const notes: Array<{ fileId: string; parsed: ReturnType<typeof parseNote> }> = [];
  paths.forEach((path, index) => {
    const fileId = `fixture-${String(index).padStart(3, '0')}`;
    const kind = path.toLowerCase().endsWith('.md') ? 'markdown' : 'attachment';
    files.push({
      fileId,
      vaultId: 'compat-fixture',
      path,
      kind,
      blobHash: `fixture-hash-${fileId}`,
      size: 1,
      mtime: 1,
      updatedRevision: 1,
    });
    if (kind === 'markdown')
      notes.push({ fileId, parsed: parseNote(readFileSync(join(vaultDir, path), 'utf8')) });
  });
  return { files, notes };
}

const { files, notes } = loadFixtureVault();
const idByPath = new Map(files.map((file) => [file.path, file.fileId]));
const pathById = new Map(files.map((file) => [file.fileId, file.path]));

let linkSequence = 0;
const rows = buildIndexRows({
  vaultId: 'compat-fixture',
  files,
  notes,
  indexedAt: 1700000000000,
  generateId: () => `compat-link-${String((linkSequence += 1)).padStart(3, '0')}`,
});
const graph = buildGraph({ files, metadata: rows.metadata, links: rows.links });
const metadataByPath = new Map(rows.metadata.map((meta) => [pathById.get(meta.fileId), meta]));

function requireFileId(path: string): string {
  const fileId = idByPath.get(path);
  if (fileId === undefined) throw new Error(`missing fixture file: ${path}`);
  return fileId;
}

function linksFrom(sourcePath: string): NoteLink[] {
  const sourceFileId = requireFileId(sourcePath);
  return rows.links.filter((link) => link.sourceFileId === sourceFileId);
}

function requireLink(sourcePath: string, raw: string): NoteLink {
  const link = linksFrom(sourcePath).find((candidate) => candidate.rawText === raw);
  if (link === undefined) throw new Error(`missing link ${raw} in ${sourcePath}`);
  return link;
}

function expectResolved(sourcePath: string, raw: string, targetPath: string): NoteLink {
  const link = requireLink(sourcePath, raw);
  expect(`${sourcePath} ${raw}`).toBeDefined();
  expect(link.targetFileId).toBe(requireFileId(targetPath));
  return link;
}

function expectUnresolved(sourcePath: string, raw: string): NoteLink {
  const link = requireLink(sourcePath, raw);
  expect(link.targetFileId).toBeNull();
  return link;
}

describe('compatibility fixture vault', () => {
  it('contains exactly the expected fixture files', () => {
    expect(listVaultFiles(vaultDir).sort()).toEqual([...expectedFiles].sort());
  });

  it('produces deterministic metadata titles', () => {
    const titleOf = (path: string): string | null => {
      const meta = metadataByPath.get(path);
      if (meta === undefined) throw new Error(`missing metadata for ${path}`);
      return meta.title;
    };
    expect(titleOf('Home.md')).toBe('Tephra compatibility vault');
    expect(titleOf('Root.md')).toBe('Root');
    expect(titleOf('Simple.md')).toBe('Simple');
    expect(titleOf('Folders/Alpha.md')).toBe('Alpha');
    expect(titleOf('Duplicate/A/Shared.md')).toBe('Shared A');
    expect(titleOf('Duplicate/B/Shared.md')).toBe('Shared B');
    expect(titleOf('Links/Headings.md')).toBe('Headings');
    expect(titleOf('Markdown/Frontmatter.md')).toBe('Frontmatter Fixture');
    expect(titleOf('Unicode/Café.md')).toBe('Café');
    expect(titleOf('Notes/Project Alpha.md')).toBe('Project Alpha');
    // Every Markdown fixture has exactly one metadata row.
    expect(rows.metadata).toHaveLength(notes.length);
  });

  it('indexes frontmatter, tags, headings, and blocks', () => {
    const frontmatter = metadataByPath.get('Markdown/Frontmatter.md');
    if (frontmatter === undefined) throw new Error('missing Markdown/Frontmatter.md metadata');
    expect(frontmatter.frontmatter).toMatchObject({ title: 'Frontmatter Fixture' });
    expect(frontmatter.tags).toEqual(expect.arrayContaining(['docs', 'fixture', 'inline-tag']));

    const tags = metadataByPath.get('Markdown/Tags.md');
    if (tags === undefined) throw new Error('missing Markdown/Tags.md metadata');
    expect(tags.tags).toEqual(expect.arrayContaining(['alpha', 'beta/gamma']));

    const headings = metadataByPath.get('Links/Headings.md');
    if (headings === undefined) throw new Error('missing Links/Headings.md metadata');
    expect(headings.headings).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: 'Section One' })]),
    );

    const blocks = metadataByPath.get('Links/Blocks.md');
    if (blocks === undefined) throw new Error('missing Links/Blocks.md metadata');
    expect(blocks.blocks).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'block-one' })]),
    );

    const referenced = metadataByPath.get('Notes/Referenced Note.md');
    if (referenced === undefined) throw new Error('missing Notes/Referenced Note.md metadata');
    expect(referenced.blocks).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'fixture-block' })]),
    );
  });

  it('resolves root, folder, alias, heading, block, and embed links', () => {
    expectResolved('Root.md', '[[Simple]]', 'Simple.md');
    expectResolved('Root.md', '[[Folders/Alpha]]', 'Folders/Alpha.md');
    expectResolved('Simple.md', '[[Root]]', 'Root.md');
    expectResolved('Folders/Alpha.md', '[[Beta]]', 'Folders/Beta.md');
    expectResolved('Folders/Alpha.md', '[[Folders/Beta]]', 'Folders/Beta.md');
    expectResolved('Folders/Beta.md', '[[Alpha]]', 'Folders/Alpha.md');

    const customLabel = expectResolved('Links/Aliases.md', '[[Simple|Custom label]]', 'Simple.md');
    expect(customLabel.displayText).toBe('Custom label');
    const folderAlias = expectResolved(
      'Links/Aliases.md',
      '[[Folders/Alpha|the alpha folder]]',
      'Folders/Alpha.md',
    );
    expect(folderAlias.displayText).toBe('the alpha folder');
    expectResolved('Links/Aliases.md', '[[Alpha]]', 'Folders/Alpha.md');

    const heading = expectResolved(
      'Links/Headings.md',
      '[[Headings#Section One]]',
      'Links/Headings.md',
    );
    expect(heading.subpath).toBe('Section One');

    const block = expectResolved('Links/Blocks.md', '[[Blocks#^block-one]]', 'Links/Blocks.md');
    expect(block.subpath).toBe('^block-one');

    const noteEmbed = expectResolved('Links/Embeds.md', '![[Simple]]', 'Simple.md');
    expect(noteEmbed.isEmbed).toBe(true);
    const attachmentEmbed = expectResolved(
      'Links/Embeds.md',
      '![[Attachments/image.png]]',
      'Attachments/image.png',
    );
    expect(attachmentEmbed.isEmbed).toBe(true);

    const rootEmbed = expectResolved('Simple.md', '![[Embeds]]', 'Links/Embeds.md');
    expect(rootEmbed.isEmbed).toBe(true);
    const rootImage = expectResolved(
      'Simple.md',
      '![[Attachments/image.png]]',
      'Attachments/image.png',
    );
    expect(rootImage.isEmbed).toBe(true);

    // Legacy fixtures keep resolving.
    const legacy = expectResolved(
      'Notes/Project Alpha.md',
      '[[Referenced Note]]',
      'Notes/Referenced Note.md',
    );
    expect(legacy.isEmbed).toBe(false);
    const legacySection = expectResolved(
      'Notes/Project Alpha.md',
      '[[Referenced Note#Details|details]]',
      'Notes/Referenced Note.md',
    );
    expect(legacySection.subpath).toBe('Details');
    expect(legacySection.displayText).toBe('details');
    expectResolved(
      'Notes/Project Alpha.md',
      '[[Referenced Note#^fixture-block]]',
      'Notes/Referenced Note.md',
    );
    expectResolved('Home.md', '[[Notes/Project Alpha|the project]]', 'Notes/Project Alpha.md');
    expectResolved('Home.md', '![[Attachments/pixel.png]]', 'Attachments/pixel.png');
  });

  it('resolves unicode paths', () => {
    expectResolved('Unicode/Café.md', '[[日本語]]', 'Unicode/日本語.md');
    expectResolved('Unicode/Café.md', '[[Spaces in name]]', 'Unicode/Spaces in name.md');
    expectResolved('Unicode/日本語.md', '[[Café]]', 'Unicode/Café.md');
    expectResolved('Unicode/Spaces in name.md', '[[Simple]]', 'Simple.md');
  });

  it('marks unknown targets as unresolved', () => {
    expectUnresolved('Links/Unresolved.md', '[[Does Not Exist]]');
    expectUnresolved('Notes/Unresolved Links.md', '[[Does Not Exist]]');
    const unresolved = rows.links.filter((link) => link.targetFileId === null);
    expect(unresolved.length).toBeGreaterThanOrEqual(2);
    expect(unresolved.map((link) => link.rawText)).toContain('[[Does Not Exist]]');
  });

  it('ignores wikilink-like tokens inside fenced and inline code', () => {
    const codeLinks = linksFrom('Markdown/Code.md');
    expect(codeLinks.map((link) => link.rawText)).toEqual(['[[Simple]]']);
    expect(codeLinks[0]?.targetFileId).toBe(requireFileId('Simple.md'));
    expect(
      rows.links.some(
        (link) =>
          link.sourceFileId === requireFileId('Markdown/Code.md') &&
          link.rawText.includes('Does Not Exist'),
      ),
    ).toBe(false);

    const projectLinks = linksFrom('Notes/Project Alpha.md').map((link) => link.rawText);
    expect(projectLinks).not.toContain('[[Ignored Inline Code]]');
    expect(projectLinks).not.toContain('[[Ignored Fenced Code]]');
  });

  it('resolves duplicate basenames toward the closest folder and flags distant ties', () => {
    const selfA = expectResolved('Duplicate/A/Shared.md', '[[Shared]]', 'Duplicate/A/Shared.md');
    expect(selfA.targetFileId).toBe(requireFileId('Duplicate/A/Shared.md'));
    const selfB = expectResolved('Duplicate/B/Shared.md', '[[Shared]]', 'Duplicate/B/Shared.md');
    expect(selfB.targetFileId).toBe(requireFileId('Duplicate/B/Shared.md'));
    // From an unrelated folder neither candidate wins, so the link stays unresolved.
    expectUnresolved('Links/Aliases.md', '[[Shared]]');
  });

  it('builds a graph without attachment or unresolved targets', () => {
    const attachmentIds = new Set(
      files.filter((file) => file.kind === 'attachment').map((file) => file.fileId),
    );
    for (const edge of graph.edges) {
      expect(attachmentIds.has(edge.target)).toBe(false);
      expect(edge.target).not.toBeNull();
    }
    const edgeBetween = (sourcePath: string, targetPath: string) =>
      graph.edges.find(
        (edge) =>
          edge.source === requireFileId(sourcePath) && edge.target === requireFileId(targetPath),
      );
    expect(edgeBetween('Root.md', 'Simple.md')).toMatchObject({ count: 1 });
    expect(edgeBetween('Links/Embeds.md', 'Simple.md')).toBeDefined();
    expect(edgeBetween('Duplicate/A/Shared.md', 'Duplicate/A/Shared.md')).toMatchObject({
      count: 1,
    });
    expect(graph.nodes.map((node) => node.path)).toContain('Unicode/日本語.md');
  });
});
