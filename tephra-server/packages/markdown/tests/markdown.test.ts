import { describe, expect, it } from 'vitest';
import { createVaultPathIndex } from '@tephra/link-resolver';
import { parseNote, renderMarkdown } from '../src/index.js';

describe('parseNote', () => {
  it('extracts frontmatter, headings, tags, blocks, wiki links, Markdown links and embeds', () => {
    const parsed = parseNote(`---
title: Project
published: true
tags: [planning, important]
aliases:
  - Alpha
---
# Design #phase/one
Text [[Folder/Note#Heading|note]], [other](../Other.md#Part), and ![[image.png]]. ^block-1`);
    expect(parsed.frontmatter).toMatchObject({ title: 'Project', published: true, aliases: ['Alpha'] });
    expect(parsed.headings).toEqual([{ level: 1, text: 'Design #phase/one', slug: 'design-phaseone', line: 8 }]);
    expect(parsed.tags).toEqual(expect.arrayContaining(['planning', 'important', 'phase/one']));
    expect(parsed.blocks).toEqual([{ id: 'block-1', line: 9 }]);
    expect(parsed.links).toMatchObject([
      { linkPath: 'Folder/Note', subpath: 'Heading', displayText: 'note', isEmbed: false, syntax: 'wiki' },
      { linkPath: '../Other.md', subpath: 'Part', isEmbed: false, syntax: 'markdown' },
      { linkPath: 'image.png', isEmbed: true, syntax: 'wiki' },
    ]);
  });

  it('ignores tags and links in inline and fenced code', () => {
    const parsed = parseNote('`[[Nope]] #nope`\n```js\nconst x = "[[Also Nope]] #bad";\n```\n[[Yes]] #good');
    expect(parsed.links.map((link) => link.linkPath)).toEqual(['Yes']);
    expect(parsed.tags).toEqual(['good']);
  });
});

describe('renderMarkdown', () => {
  it('escapes raw HTML and blocks dangerous URL schemes', async () => {
    const rendered = await renderMarkdown({
      markdown: '# Safe\n<script>alert(1)</script> [bad](java\nscript:alert(1)) ![bad](data:text/html,x)',
      sourcePath: 'Safe.md',
    });
    expect(rendered.html).toContain('&lt;script&gt;');
    expect(rendered.html).not.toContain('<script>');
    expect(rendered.html).not.toContain('data:text/html');
    expect(rendered.html).not.toContain('javascript:');
  });

  it('preserves internal routing tokens and renders resolved attachment embeds', async () => {
    const rendered = await renderMarkdown({
      markdown: '[[Note#Part|read]] ![[pic.png]]',
      sourcePath: 'Home.md',
      vaultIndex: createVaultPathIndex([
        { fileId: 'note', path: 'Note.md', kind: 'markdown' },
        { fileId: 'pic', path: 'pic.png', kind: 'attachment' },
      ]),
      attachmentUrl: () => '/files/pic',
    });
    expect(rendered.html).toContain('data-link-path="Note"');
    expect(rendered.html).toContain('data-subpath="Part"');
    expect(rendered.html).toContain('<img src="/files/pic"');
  });

  it('does not turn code examples into routed links', async () => {
    const rendered = await renderMarkdown({ markdown: '`[[not a link]]`', sourcePath: 'Home.md' });
    expect(rendered.html).toContain('<code>[[not a link]]</code>');
    expect(rendered.html).not.toContain('data-link-path');
  });
});
