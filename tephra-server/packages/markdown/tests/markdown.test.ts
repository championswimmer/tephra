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

  it('emits file ids for resolved links and unresolved markers for missing notes', async () => {
    const rendered = await renderMarkdown({
      markdown: '[[Note#Part|read]] [other](Other.md) [[Missing]] [gone](Gone.md)',
      sourcePath: 'Home.md',
      vaultIndex: createVaultPathIndex([
        { fileId: 'note-id', path: 'Note.md', kind: 'markdown' },
        { fileId: 'other-id', path: 'Other.md', kind: 'markdown' },
      ]),
    });
    expect(rendered.html).toContain('data-file-id="note-id"');
    expect(rendered.html).toContain('data-file-id="other-id"');
    expect(rendered.html).toContain('data-unresolved-target="Missing"');
    expect(rendered.html).toContain('data-unresolved-target="Gone.md"');
  });

  it('does not turn code examples into routed links', async () => {
    const rendered = await renderMarkdown({ markdown: '`[[not a link]]`', sourcePath: 'Home.md' });
    expect(rendered.html).toContain('<code>[[not a link]]</code>');
    expect(rendered.html).not.toContain('data-link-path');
  });

  it('renders blockquotes including nesting', async () => {
    const rendered = await renderMarkdown({ markdown: '> outer\n>> nested', sourcePath: 'Home.md' });
    expect(rendered.html).toContain('<blockquote>');
    expect(rendered.html).toContain('outer');
    expect(rendered.html).toContain('<blockquote>\n<p>nested</p>');
  });

  it('groups checklists without bullets', async () => {
    const rendered = await renderMarkdown({ markdown: '- [ ] todo\n- [x] done', sourcePath: 'Home.md' });
    expect(rendered.html).toContain('<ul class="contains-task-list">');
    expect(rendered.html).toContain('class="task-list-item"');
    expect(rendered.html).toContain('checked');
    expect(rendered.html.match(/<ul/g)?.length).toBe(1);
  });

  it('renders GFM tables with alignment and inline markup', async () => {
    const rendered = await renderMarkdown({
      markdown: '| Directive | Meaning |\n| --------- | ------- |\n| `max-age` | Freshness |',
      sourcePath: 'Home.md',
    });
    expect(rendered.html).toContain('<table>');
    expect(rendered.html).toContain('<th>Directive</th>');
    expect(rendered.html).toContain('<td><code>max-age</code></td>');
  });

  it('does not treat pipes without a delimiter row as a table', async () => {
    const rendered = await renderMarkdown({ markdown: 'a | b\njust text', sourcePath: 'Home.md' });
    expect(rendered.html).not.toContain('<table>');
  });

  it('keeps wikilink alias pipes inside a single table cell', async () => {
    const rendered = await renderMarkdown({
      markdown: '| Feature | Example |\n| ------- | ------- |\n| Link | [[Engineering/SQLite|SQLite]] |',
      sourcePath: 'Home.md',
    });
    expect(rendered.html).toContain('<table>');
    expect(rendered.html).toContain('<td><a href="#" class="tephra-link" data-link-path="Engineering/SQLite">SQLite</a></td>');
  });

  it('renders Obsidian callouts with default titles', async () => {
    const rendered = await renderMarkdown({ markdown: '> [!note]\n> Body text.', sourcePath: 'Home.md' });
    expect(rendered.html).toContain('<div class="callout" data-callout="note">');
    expect(rendered.html).toContain('callout-title-inner">Note</div>');
    expect(rendered.html).toContain('<div class="callout-content">');
    expect(rendered.html).not.toContain('<blockquote>');
  });

  it('renders callout custom titles and fold markers', async () => {
    const custom = await renderMarkdown({ markdown: '> [!tip] Custom\n> Body.', sourcePath: 'Home.md' });
    expect(custom.html).toContain('callout-title-inner">Custom</div>');
    const collapsed = await renderMarkdown({ markdown: '> [!faq]- Title\n> Body.', sourcePath: 'Home.md' });
    expect(collapsed.html).toContain('<details class="callout" data-callout="faq">');
    expect(collapsed.html).not.toContain(' open>');
    const expanded = await renderMarkdown({ markdown: '> [!faq]+ Title\n> Body.', sourcePath: 'Home.md' });
    expect(expanded.html).toContain('<details class="callout" data-callout="faq" open>');
  });

  it('falls back to note styling for unknown callout types', async () => {
    const rendered = await renderMarkdown({ markdown: '> [!bogus]\n> Body.', sourcePath: 'Home.md' });
    expect(rendered.html).toContain('data-callout="bogus"');
    expect(rendered.html).toContain('callout-title-inner">Bogus</div>');
  });
});
