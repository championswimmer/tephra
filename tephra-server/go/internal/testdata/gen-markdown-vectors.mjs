#!/usr/bin/env node
// Generates cross-implementation vectors for the Go markdown and link-resolver
// ports from the TypeScript sources of record.
//
//   cd tephra-server && npx tsx go/internal/testdata/gen-markdown-vectors.mjs
//
// Writes markdown-vectors.json and linkresolver-vectors.json next to this file.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMarkdown } from '../../../packages/markdown/src/index.ts';
import { createVaultPathIndex, resolveLink } from '../../../packages/link-resolver/src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));

// ---------- deterministic PRNG ----------
let state = 0x2545f491;
function rand() {
  state ^= state << 13; state >>>= 0;
  state ^= state >>> 17;
  state ^= state << 5; state >>>= 0;
  return state / 4294967296;
}
const pick = (list) => list[Math.floor(rand() * list.length)];

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

// ---------- markdown ----------
const vaultFiles = [
  { fileId: 'f-note', path: 'Note.md', kind: 'markdown' },
  { fileId: 'f-other', path: 'Other.md', kind: 'markdown' },
  { fileId: 'f-eng-sqlite', path: 'Engineering/SQLite.md', kind: 'markdown' },
  { fileId: 'f-a-dup', path: 'A/Dup.md', kind: 'markdown' },
  { fileId: 'f-b-dup', path: 'B/Dup.md', kind: 'markdown' },
  { fileId: 'f-pic', path: 'pic.png', kind: 'attachment' },
  { fileId: 'f-img', path: 'Assets/my image.png', kind: 'attachment' },
  { fileId: 'f-cafe', path: 'Cafe\u{301}.md', kind: 'markdown' },
  { fileId: 'f-uni', path: 'Notes/日本語.md', kind: 'markdown' },
  { fileId: 'f-home', path: 'Home.md', kind: 'markdown' },
];

const curated = [
  '',
  'plain text',
  '# Heading',
  '#NoSpace',
  '###### Six ######',
  '####### Seven',
  '# Trailing hashes ##   ',
  '# Design #phase/one\n\nText',
  '---\ntitle: Project\npublished: true\ntags: [planning, important]\naliases:\n  - Alpha\n---\n# Design #phase/one\nText [[Folder/Note#Heading|note]], [other](../Other.md#Part), and ![[image.png]]. ^block-1',
  '---\r\ntitle: CRLF\r\ntags: a, b\r\n---\r\nbody #tag\r\n',
  '---\ntitle: x\n',
  '---\n---\nempty frontmatter',
  '---\nkey:\nother: 1.5\nneg: -3\nnum: .5\nbig: 12345678901234567890\nz: -0\nq: "quoted"\ns: \'single\'\nn: null\nt: ~\nf: false\nl: [1, "a", true, ]\nnest: [[a], b]\nempty: []\nquote: "\n---\nx',
  '---\ntags:\n  - one\n  - "#two"\n  - 3\n---\n#three',
  '---\ntag: #solo\n---\n',
  '---\ntags: null\ntag: fallback, other\n---\n',
  '---\ntags: 5\n---\n#x',
  '---\ntags: [a, #b, "#c"]\n---\n',
  '---\n1: one\nb: two\n0: zero\n10: ten\n01: lead\n__proto__: x\nconstructor: y\na.b-c: 1\nlist:\n- x\n- y\nlist:\n- z\n---\n',
  '---\ntitle: with ... inside\n...\nafter dots',
  '---\nkey: value\n  - orphan\n- orphan2\nk:\n  - a\nk2: v\n  - ignored\n---\n',
  '---\nu: émoji 😀 value\nk: "😀"\n---\n',
  '`[[Nope]] #nope`\n```js\nconst x = "[[Also Nope]] #bad";\n```\n[[Yes]] #good',
  '~~~\n[[In tilde]]\n~~~\n[[Out]]',
  '```\n[[unclosed]]\n#tag',
  '````\n```\ninner\n```\n````\n[[after]]',
  '```\ncode\n~~~\nstill code\n```\n[[a]]',
  '  ```\nindented fence [[x]]\n  ```\n[[y]]',
  '\n\n```\nblank-line fence lookahead [[x]]\n```\n[[y]]',
  '   \n```\nfoo\n```',
  '``double `tick` code`` [[a]]',
  '```inline``` [[a]] ``` [[b]]',
  '`unclosed [[a]]',
  '````x```` and ``` y ``` [[z]]',
  '😀 `[[not]]` [[yes]] 😀',
  '😀 😀 ```\n[[hidden]]\n``` [[shown]] ^id',
  '😀 `code` [[shown]] 😀 `more [[hidden]]` [[after]]',
  '😀`a`[[b]]`c`[[d]]',
  '[[Note#Part|read]] ![[pic.png]]',
  '[[Note#Part|read]] [other](Other.md) [[Missing]] [gone](Gone.md)',
  '[[Note|]] [[Note|a|b]] [[|alias]] [[#heading]] [[ ]] [[Note#]] [[Note# sub ]] [[ Note ]]',
  '![[Note]] ![[pic.png|caption]] ![[Assets/my image.png]] ![[Missing.png]] ![[pic.png#frag]]',
  '[a](<Other.md>) [b](<Other.md> "Title") [c](Other.md \'T\') [d](Other.md "unterminated) [e](<) [f](>) [g](<>)',
  '[x](Other.md#Head%20Ing) [y](%5E) [z](sub folder/Note.md) [w](#only)',
  '[ext](https://example.com/a?b=1&c=2) [prot](//cdn.example.com/x) ![img](https://example.com/i.png) ![rel](pic.png)',
  '[bad](javascript:alert(1)) [bad2](JaVaScRiPt:alert(1)) [bad3](java\nscript:alert(1)) [bad4](&#106;avascript:alert(1)) [bad5](&#x6A;avascript:1) [bad6](data:text/html,x) [bad7](vbscript:x)',
  '[ent](&#x110000;)',
  '[ent](&#99999999999;)',
  '[ent](&#xD800;x) [ok](&#65;bc) [semi](&#66) [none](&#xZ)',
  '[bad ws](java\tscript:1) [nbsp](java\u{a0}script:1) [ctl](java\u0001script:1)',
  '<https://example.com/a?b=1&c=2> <me@example.com> <a link> <javascript:alert(1)> `<https://code.example>` <ftp://x> <a:b> <ab:> <x@y> <a@b.c.d> <a@-b.c>',
  '<mailto:x@y.z> <HTTP://UP.CASE> <https://a.b/c d> <http://x/<y>',
  '# Safe\n<script>alert(1)</script> [bad](java\nscript:alert(1)) ![bad](data:text/html,x)',
  '**bold** *em* ***both*** **unclosed *x* **a** `**code**` *a*b*c* **a*b**',
  '**bold\nacross** *em\nacross*',
  'line one\nline two\n\nsecond para\n\n\n\nthird',
  'a & b < c > d " e \' f',
  '> outer\n>> nested',
  '> quote\nlazy continuation\n\nafter',
  '>no space\n>  two spaces\n   > indented three\n    > four spaces',
  '> a\n\n> b',
  '> a\n>\n> c',
  '>',
  '> \n> ',
  '> - item\n> - item2',
  '> ```\n> code in quote\n> ```',
  '> [!note]\n> Body text.',
  '> [!note] Title\n> Body **bold** [[Note]]',
  '> [!tip] Custom\n> Body.',
  '> [!faq]- Title\n> Body.',
  '> [!faq]+ Title\n> Body.',
  '> [!bogus]\n> Body.',
  '> [!constructor] x',
  '> [!WARNING]\n> shout',
  '> [!caution]- \n> body\n> > [!nested] inner\n> > body',
  '> [!note]\n\n> [!info]\n> second',
  '> [!a-b_c] weird',
  '> [!note]Title no space',
  '> [!summary]\n> a\n>\n> b\n> - list',
  ...['note', 'abstract', 'summary', 'tldr', 'info', 'todo', 'tip', 'hint', 'important', 'success', 'check', 'done', 'question', 'help', 'faq', 'warning', 'caution', 'attention', 'failure', 'fail', 'missing', 'danger', 'error', 'bug', 'example', 'quote', 'cite'].map((t) => `> [!${t}]\n> body`),
  '- a\n- b\n* c\n+ d',
  '- [ ] todo\n- [x] done\n- [X] DONE\n- plain\n-   spaced',
  '- item\ntext right after',
  '- a\n\n- b',
  '  - indented\n\t- tab',
  '-no space\n- ',
  '- [ ]no space\n- [x]',
  '```ts title="a"\nconst a = 1;\n```',
  '~~~python\nprint(1)\n~~~',
  '```\nplain\n```',
  '```"><script>\nx\n```',
  '```c++\nint x;\n```\n```c#\nx\n```\n```a.b-c_d\ny\n```',
  '```js extra words\ncode <b>&\n```',
  '```\nunterminated <b>',
  '```\n```',
  '```\n\n```',
  '``` js\nspace lang\n```',
  '```\na\n````\nb\n```',
  '~~~\nx\n```\ny\n~~~',
  '| Directive | Meaning |\n| --------- | ------- |\n| `max-age` | Freshness |',
  '| a | b |\n|:--|--:|\n| 1 | 2 |\n| 3 |\n| 4 | 5 | 6 |',
  '|a|b|\n|:-:|-|\n|x|y|',
  'a | b\n--|--\n1 | 2',
  'a | b\njust text',
  '| Feature | Example |\n| ------- | ------- |\n| Link | [[Engineering/SQLite|SQLite]] |',
  '| a | b |\n| --- | --- |\n| `x|y` | [l|m](u) |\n| esc \\| pipe | \\x |',
  '| a | b |\n| --- | --- |\n\nafter',
  '| a | b |\n| --- | ---',
  '| a | b |\n| --- |\n| 1 | 2 |',
  '| a | b |\n| ---a | --- |',
  '| a |\n| --- |\n| 1 |\n| 2 |\ntext | not row\nmore',
  '|\n|\n',
  '| a | b |\n| - | - |\n| trailing \\',
  '> | a | b |\n> | - | - |\n> | 1 | 2 |',
  '| [[a]] | `|` |\n|---|---|\n| [[b|c]] | ![[pic.png]] |',
  '# Café Ünïcode 日本語\n## Ὀδυσσεύς ΣΑΣ\n### İstanbul İ\n#### Straße ǅ\n##### a_b-c d.e!f\n###### 😀 emoji',
  '# ΑΣ\n# ΑΣ Β\n# Σ\n# ΑΣ.\n# ΑΣ.Β',
  '# Heading with `code` and **bold** and [[Note]]',
  '#   spaced   heading   ',
  '# a # b #',
  '#\n# \n#\u{a0}nbsp\n#\u{2003}em',
  'Text with #tag and #tag/nested and #日本語 and #a-b_c #123 (#paren) a#nothash\n#line-start',
  '#tag1 #tag2\ttab #tag3',
  'Paragraph ^block-1\n\n- list item ^item-2\n\n^only\n text ^bad id! ^ok-3   ',
  'trailing ^id\u{a0}',
  'x\u{2028}y [[a]]\u{2028} # not heading',
  '# head\u{2028}ing',
  'CRLF line one\r\nline two\r\n\r\n# Head\r\n- item\r\n> quote\r\n```\r\ncode\r\n```\r\n',
  'lone \r carriage\rreturn',
  'private \u{e000} use \u{e001} chars \u{e000}0\u{e001}',
  '\u{e000}',
  'tabs\there\u{a0}nbsp\u{3000}ideo',
  '[[a]] [[b]]\n![[c]]\n[d](e)',
  '[[a\nb]] [x\ny](z) [x](y\nz)',
  '[[Note]]]] [[[Note]]] [[Note]',
  '![[Note#^block]] [[Note#^block|alias]]',
  '[[Folder/Sub/Deep Note#H1#H2|x]]',
  '[[Note]](Other.md)',
  '[[Cafe\u{301}]] [[Caf\u{e9}]] [[日本語]] [[Notes/日本語]] [[dup]] [[A/Dup]] [[Dup]]',
  '[](empty) [ ]( ) [x]()',
  `${'a'.repeat(300)} [[Note]] ${'b'.repeat(300)}`,
  Array.from({ length: 30 }, (_, i) => `- item ${i} [[Note]]`).join('\n'),
];

const fragments = [
  '# Title', '## Sub #tag', '### 日本語 Ünï', 'plain words here', 'text with #tag and #a/b', '[[Note]]', '[[Note#Part|alias]]',
  '![[pic.png]]', '![[Missing]]', '[l](Other.md#x)', '[e](https://x.y/z?a=1&b=2)', '[bad](javascript:x)', '`code [[x]]`', '``a`b``',
  '```', '```js', '~~~', '> quote', '> [!note] T', '> [!faq]- F', '>> deep', '- item', '- [ ] task', '- [x] done', '* star',
  '| a | b |', '| --- | :-: |', '| 1 | [[Note|n]] |', 'a | b', '**bold**', '*em*', '<https://auto.link>', '<me@x.io>', '<b>raw</b>',
  '', '', '', '^blk-1', 'text ^blk-2', '---', '...', '&#106;avascript:x', '[[Cafe\u{301}]]', '😀 emoji', '\\| esc', '\t', '  ',
  '[[A/Dup]]', '[[Dup]]', '[[日本語]]', 'ΑΣ Σ', '#', '# ', '1. ordered', '|', '`', '``', '[', ']', '[[', ']]', '(', ')',
];

function randomDoc() {
  const lines = [];
  if (rand() < 0.2) lines.push('---', pick(['title: T', 'tags: [a, b]', 'k:', '  - v', 'n: 3', 'tag: x y']), pick(['tags:', 'z: "q"', 'b: true']), '---');
  const n = 1 + Math.floor(rand() * 14);
  for (let i = 0; i < n; i += 1) {
    let line = pick(fragments);
    if (rand() < 0.25) line += ` ${pick(fragments)}`;
    lines.push(line);
  }
  return lines.join(rand() < 0.1 ? '\r\n' : '\n');
}

const docs = [...curated];
for (let i = 0; i < 1500; i += 1) docs.push(randomDoc());

const markdownVectors = [];
let skipped = 0;
const sources = ['Home.md', 'Folder/Sub/Note.md', 'A/Source.md'];
for (const [i, markdown] of docs.entries()) {
  const sourcePath = sources[i % sources.length];
  for (const mode of ['plain', 'index']) {
    const options = { markdown, sourcePath };
    if (mode === 'index') {
      options.vaultIndex = createVaultPathIndex(vaultFiles);
      options.attachmentUrl = (id) => `/files/${id}?x=1&y=<2>`;
    }
    let expected;
    try {
      expected = { ok: await renderMarkdown(options) };
    } catch (error) {
      expected = { error: String(error?.name ?? 'Error') };
    }
    if (LONE_SURROGATE.test(JSON.stringify(expected)) || LONE_SURROGATE.test(markdown)) { skipped += 1; continue; }
    markdownVectors.push({ markdown, sourcePath, mode, expected });
  }
}

writeFileSync(join(here, 'markdown-vectors.json'), `${JSON.stringify({ vaultFiles, vectors: markdownVectors }, null, 1)}\n`);
console.log(`markdown vectors: ${markdownVectors.length} (skipped ${skipped} with lone surrogates)`);

// ---------- link resolver ----------
const indexes = {
  basic: [
    { fileId: 'root-project', path: 'Project.md', kind: 'markdown' },
    { fileId: 'one-note', path: 'One/Note.md', kind: 'markdown' },
    { fileId: 'two-note', path: 'Two/Note.md', kind: 'markdown' },
    { fileId: 'other', path: 'Two/Other Note.md', kind: 'markdown' },
    { fileId: 'image', path: 'Assets/my image.png', kind: 'attachment' },
  ],
  rich: [
    { fileId: 'a1', path: 'Daily/2024-01-01.md', kind: 'markdown' },
    { fileId: 'a2', path: 'Daily/2024-01-02.md', kind: 'markdown' },
    { fileId: 'a3', path: 'Projects/Alpha/Readme.md', kind: 'markdown' },
    { fileId: 'a4', path: 'Projects/Beta/Readme.md', kind: 'markdown' },
    { fileId: 'a5', path: 'Projects/Beta/Deep/Readme.md', kind: 'markdown' },
    { fileId: 'a6', path: 'readme.md', kind: 'markdown' },
    { fileId: 'a7', path: 'README.MD', kind: 'markdown' },
    { fileId: 'a8', path: 'Attachments/Photo.PNG', kind: 'attachment' },
    { fileId: 'a9', path: 'Attachments/photo.png', kind: 'attachment' },
    { fileId: 'b1', path: 'Zebra.md', kind: 'markdown' },
    { fileId: 'b2', path: 'apple.md', kind: 'markdown' },
    { fileId: 'b3', path: 'Apple.md', kind: 'markdown' },
    { fileId: 'b4', path: 'Äpfel.md', kind: 'markdown' },
    { fileId: 'b5', path: 'Eclair.md', kind: 'markdown' },
    { fileId: 'b6', path: 'Éclair.md', kind: 'markdown' },
    { fileId: 'b7', path: 'Notes/with space.md', kind: 'markdown' },
    { fileId: 'b8', path: 'Notes/with-dash.md', kind: 'markdown' },
    { fileId: 'b9', path: 'Notes/with_under.md', kind: 'markdown' },
    { fileId: 'c1', path: 'Notes/100.md', kind: 'markdown' },
    { fileId: 'c2', path: 'Notes/20.md', kind: 'markdown' },
    { fileId: 'c3', path: 'Notes/3.md', kind: 'markdown' },
    { fileId: 'c4', path: '日本語/ノート.md', kind: 'markdown' },
    { fileId: 'c5', path: 'Straße.md', kind: 'markdown' },
    { fileId: 'c6', path: 'Strasse.md', kind: 'markdown' },
    { fileId: 'c7', path: 'İstanbul.md', kind: 'markdown' },
    { fileId: 'c8', path: 'ΑΣ.md', kind: 'markdown' },
    { fileId: 'c9', path: 'Cafe\u{301}.md', kind: 'markdown' },
    { fileId: 'd1', path: 'Caf\u{e9}/Menu.md', kind: 'markdown' },
    { fileId: 'd2', path: 'Folder.with.dots/Note.v2.md', kind: 'markdown' },
    { fileId: 'd3', path: 'Data/file.json', kind: 'attachment' },
    { fileId: 'd4', path: 'Data/file.json.md', kind: 'markdown' },
    { fileId: 'd5', path: '.hidden/Secret.md', kind: 'markdown' },
    { fileId: 'd6', path: 'Back\\slash.md', kind: 'markdown' },
    { fileId: 'd7', path: 'Percent%20Literal.md', kind: 'markdown' },
    { fileId: 'd8', path: '_underscore.md', kind: 'markdown' },
    { fileId: 'd9', path: '(paren).md', kind: 'markdown' },
  ],
  weird: [
    { fileId: 'w1', path: '../escape.md', kind: 'markdown' },
    { fileId: 'w2', path: 'dir/../Note.md', kind: 'markdown' },
    { fileId: 'w3', path: '/leading.md', kind: 'markdown' },
    { fileId: 'w4', path: 'trail/', kind: 'attachment' },
    { fileId: 'w5', path: 'a//b.md', kind: 'markdown' },
    { fileId: 'w6', path: './dot.md', kind: 'markdown' },
  ],
  empty: [],
};

const linkSources = ['Source.md', 'One/Source.md', 'One/Subfolder/Source.md', 'Elsewhere/Source.md', 'Projects/Beta/Deep/Source.md', 'Projects/Alpha/x.md', 'Daily/Today.md', '../out.md', 'a/../b/Src.md', 'Project.md', 'Notes/with space.md', 'Cafe\u{301}.md', 'Caf\u{e9}/Menu.md'];
const linkTargets = [
  'Project', 'Project.md', 'project', 'PROJECT.MD', 'Note', 'note', 'One/Note', 'Two/Note.md', 'Note#Heading', 'Note#', '#', '#Heading', '', 'Missing', 'Missing#x',
  'Two/Other%20Note.md#Heading%20One', 'Project#%5Eblock-1', 'Assets/my%20image.png', 'my image.png', 'my%20image', '%', '%E0%A4%A', '%zz', '%C0%80', '%ED%A0%80', 'a%2Fb',
  '/Project', '//Project//', '\\Project', 'One\\Note', './Project', '../Project', '../../Project', 'One/../Project', 'One/./Note', '.', '..', '/', './',
  'Readme', 'readme', 'README.md', 'Alpha/Readme', 'Beta/Readme', 'Deep/Readme', 'Beta/Deep/Readme', 'Projects/Beta/Readme', 'Photo.png', 'photo.PNG', 'Attachments/Photo.PNG',
  'apple', 'Apple', 'APPLE', 'Äpfel', 'Apfel', 'Eclair', 'Éclair', 'E\u{301}clair', 'Cafe\u{301}', 'Caf\u{e9}', 'Café/Menu', 'Cafe\u{301}/Menu.md', 'Menu',
  'with space', 'with-dash', 'with_under', 'with%20space', '100', '20', '3', 'ノート', '日本語/ノート', '日本語/ノート.md',
  'Straße', 'STRASSE', 'strasse', 'İstanbul', 'i\u{307}stanbul', 'istanbul', 'ΑΣ', 'ας', 'ασ', 'ΑΣ.md', 'Note.v2', 'Note.v2.md', 'Folder.with.dots/Note.v2', 'file', 'file.json', 'file.json.md', 'Data/file',
  'Secret', '.hidden/Secret', 'escape', 'Back\\slash', 'Back/slash', 'Percent%2520Literal', 'Percent%20Literal', '_underscore', '(paren)', '%28paren%29',
  'leading', 'trail', 'b', 'a/b', 'dot', 'Note.MD', 'note.md#X%20Y', 'Daily/2024-01-01', '2024-01-01', '2024-01-02#h',
];

const linkVectors = [];
for (const [name, files] of Object.entries(indexes)) {
  const index = createVaultPathIndex(files);
  const cases = [];
  for (const source of linkSources) {
    for (const target of linkTargets) cases.push({ source, target, result: resolveLink(source, target, index) });
  }
  linkVectors.push({ name, files, sortedPaths: index.files.map((f) => f.path), cases });
}

// Shuffled input orders exercise the index sort and tie-breaking.
for (let r = 0; r < 5; r += 1) {
  const files = indexes.rich.map((f) => ({ f, k: rand() })).sort((a, b) => a.k - b.k).map(({ f }) => f);
  const index = createVaultPathIndex(files);
  const cases = [];
  for (let i = 0; i < 400; i += 1) {
    const source = pick(linkSources);
    const target = pick(linkTargets);
    cases.push({ source, target, result: resolveLink(source, target, index) });
  }
  linkVectors.push({ name: `rich-shuffle-${r}`, files, sortedPaths: index.files.map((f) => f.path), cases });
}

writeFileSync(join(here, 'linkresolver-vectors.json'), `${JSON.stringify({ indexes: linkVectors }, null, 1)}\n`);
console.log(`link resolver index sets: ${linkVectors.length}, cases: ${linkVectors.reduce((n, v) => n + v.cases.length, 0)}`);
