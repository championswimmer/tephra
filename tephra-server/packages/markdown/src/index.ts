import { resolveLink as resolveVaultLink, type VaultPathIndex } from '@tephra/link-resolver';

export interface HeadingInfo {
  level: number;
  text: string;
  slug: string;
  line: number;
}

export interface BlockInfo {
  id: string;
  line: number;
}

export type LinkSyntax = 'wiki' | 'markdown';

export interface ParsedLink {
  raw: string;
  linkPath: string;
  subpath?: string;
  displayText?: string;
  isEmbed: boolean;
  syntax: LinkSyntax;
}

export interface ParsedNote {
  frontmatter: Record<string, unknown>;
  headings: HeadingInfo[];
  tags: string[];
  blocks: BlockInfo[];
  links: ParsedLink[];
}

export interface RenderedNote extends ParsedNote {
  html: string;
}

export interface RenderTarget {
  targetFileId: string | null;
  targetPath: string | null;
  unresolved: boolean;
  ambiguous?: boolean;
  targetKind?: 'markdown' | 'attachment' | null;
  /** @deprecated Use targetKind. Retained for lightweight renderer adapters. */
  kind?: 'markdown' | 'attachment';
}

export interface MarkdownRenderOptions {
  markdown: string;
  sourcePath: string;
  vaultIndex?: VaultPathIndex;
  resolveLink?: (sourcePath: string, linkPath: string) => RenderTarget;
  attachmentUrl?: (fileId: string) => string;
}

const escapeHtml = (value: string): string => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

function slugify(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[^\p{Letter}\p{Number}\s-]/gu, '').replace(/\s+/g, '-');
}

function parseScalar(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null' || trimmed === '~') return null;
  if (/^-?(?:\d+|\d*\.\d+)$/.test(trimmed)) return Number(trimmed);
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed.slice(1, -1).split(',').map((part) => parseScalar(part)).filter((part) => part !== '');
  }
  return trimmed;
}

function readFrontmatter(markdown: string): { frontmatter: Record<string, unknown>; body: string; offset: number } {
  if (!markdown.startsWith('---\n') && !markdown.startsWith('---\r\n')) return { frontmatter: {}, body: markdown, offset: 0 };
  const lines = markdown.split(/\r?\n/);
  const end = lines.findIndex((line, index) => index > 0 && (line === '---' || line === '...'));
  if (end < 0) return { frontmatter: {}, body: markdown, offset: 0 };
  const result: Record<string, unknown> = {};
  let activeList: string | undefined;
  for (const line of lines.slice(1, end)) {
    const listItem = /^\s*-\s+(.+)$/.exec(line);
    if (listItem && activeList !== undefined) {
      const list = result[activeList];
      if (Array.isArray(list)) list.push(parseScalar(listItem[1] ?? ''));
      continue;
    }
    const pair = /^([\w.-]+):(?:\s*(.*))?$/.exec(line);
    if (!pair) continue;
    const key = pair[1] ?? '';
    const value = pair[2] ?? '';
    if (value === '') {
      result[key] = [];
      activeList = key;
    } else {
      result[key] = parseScalar(value);
      activeList = undefined;
    }
  }
  return { frontmatter: result, body: lines.slice(end + 1).join('\n'), offset: end + 1 };
}

function splitTarget(value: string): { linkPath: string; subpath?: string } {
  const hash = value.indexOf('#');
  if (hash < 0) return { linkPath: value.trim() };
  const linkPath = value.slice(0, hash).trim();
  const subpath = value.slice(hash + 1).trim();
  return subpath === '' ? { linkPath } : { linkPath, subpath };
}

function maskedCodeRanges(markdown: string): string {
  const chars = [...markdown];
  let fence: string | undefined;
  for (let index = 0; index < chars.length;) {
    const lineStart = index === 0 || chars[index - 1] === '\n';
    if (lineStart) {
      const rest = chars.slice(index).join('');
      const match = /^(\s*)(`{3,}|~{3,})/.exec(rest);
      if (match) {
        const marker = (match[2] ?? '').charAt(0);
        const length = (match[2] ?? '').length;
        if (fence === undefined) fence = marker.repeat(length);
        else if (fence.charAt(0) === marker && length >= fence.length) fence = undefined;
      }
    }
    if (fence !== undefined) {
      if (chars[index] !== '\n') chars[index] = ' ';
      index += 1;
      continue;
    }
    if (chars[index] === '`') {
      let ticks = 1;
      while (chars[index + ticks] === '`') ticks += 1;
      const closing = markdown.indexOf('`'.repeat(ticks), index + ticks);
      if (closing >= 0) {
        for (let cursor = index; cursor < closing + ticks; cursor += 1) if (chars[cursor] !== '\n') chars[cursor] = ' ';
        index = closing + ticks;
        continue;
      }
    }
    index += 1;
  }
  return chars.join('');
}

function parseLinks(body: string): ParsedLink[] {
  const masked = maskedCodeRanges(body);
  const found: Array<{ index: number; link: ParsedLink }> = [];
  const occupied: Array<[number, number]> = [];
  const wiki = /(!?)\[\[([^\]\n]+)\]\]/g;
  for (const match of masked.matchAll(wiki)) {
    const index = match.index;
    const raw = body.slice(index, index + match[0].length);
    const inner = (match[2] ?? '').split('|');
    const target = splitTarget(inner[0] ?? '');
    if (target.linkPath === '') continue;
    found.push({ index, link: { raw, ...target, ...(inner[1] === undefined ? {} : { displayText: inner.slice(1).join('|').trim() }), isEmbed: match[1] === '!', syntax: 'wiki' } });
    occupied.push([index, index + match[0].length]);
  }
  const markdownLink = /(!?)\[([^\]\n]*)\]\(([^)\n]+)\)/g;
  for (const match of masked.matchAll(markdownLink)) {
    const index = match.index;
    if (occupied.some(([start, end]) => index >= start && index < end)) continue;
    let destination = (match[3] ?? '').trim();
    if (destination.startsWith('<') && destination.endsWith('>')) destination = destination.slice(1, -1);
    const title = /^(\S+)(?:\s+["'].*["'])$/.exec(destination);
    if (title) destination = title[1] ?? destination;
    const target = splitTarget(destination);
    found.push({ index, link: { raw: body.slice(index, index + match[0].length), ...target, displayText: match[2] ?? '', isEmbed: match[1] === '!', syntax: 'markdown' } });
  }
  return found.sort((a, b) => a.index - b.index).map(({ link }) => link);
}

function frontmatterTags(frontmatter: Record<string, unknown>): string[] {
  const value = frontmatter.tags ?? frontmatter.tag;
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[ ,]+/) : [];
  return values.filter((item): item is string => typeof item === 'string').map((tag) => tag.replace(/^#/, '')).filter(Boolean);
}

export function parseNote(markdown: string): ParsedNote {
  const { frontmatter, body, offset } = readFrontmatter(markdown);
  const masked = maskedCodeRanges(body);
  const headings: HeadingInfo[] = [];
  const blocks: BlockInfo[] = [];
  const tags = new Set(frontmatterTags(frontmatter));
  const lines = body.split('\n');
  const maskedLines = masked.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const safeLine = maskedLines[index] ?? '';
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(safeLine);
    if (heading) {
      const text = (heading[2] ?? '').trim();
      headings.push({ level: (heading[1] ?? '').length, text, slug: slugify(text), line: index + offset + 1 });
    }
    for (const block of safeLine.matchAll(/(?:^|\s)\^([A-Za-z0-9-]+)\s*$/g)) blocks.push({ id: block[1] ?? '', line: index + offset + 1 });
    for (const tag of safeLine.matchAll(/(^|[\s(])#([\p{Letter}\p{Number}_/-]+)/gu)) tags.add(tag[2] ?? '');
  }
  return { frontmatter, headings, tags: [...tags].filter(Boolean), blocks, links: parseLinks(body) };
}

function safeHref(value: string): string | null {
  const decodedEntities = value.replace(/&#(?:x([\da-f]+)|(\d+));?/gi, (_match, hex: string | undefined, decimal: string | undefined) =>
    String.fromCodePoint(Number.parseInt(hex ?? decimal ?? '0', hex === undefined ? 10 : 16)));
  const compact = [...decodedEntities]
    .filter((character) => (character.codePointAt(0) ?? 0) > 0x20)
    .join('')
    .toLocaleLowerCase();
  if (compact.startsWith('javascript:') || compact.startsWith('data:') || compact.startsWith('vbscript:')) return null;
  return value;
}

function resolveForRender(options: MarkdownRenderOptions, target: string): RenderTarget | undefined {
  if (options.resolveLink) return options.resolveLink(options.sourcePath, target);
  if (options.vaultIndex) return resolveVaultLink(options.sourcePath, target, options.vaultIndex);
  return undefined;
}

function renderInline(value: string, options: MarkdownRenderOptions): string {
  const tokens: string[] = [];
  const store = (html: string): string => `\uE000${String(tokens.push(html) - 1)}\uE001`;
  let output = value.replace(/(`+)([^`]*?)\1/g, (_raw, _ticks: string, codeValue: string) => store(`<code>${escapeHtml(codeValue)}</code>`));
  output = output.replace(/(!?)\[\[([^\]\n]+)\]\]/g, (_raw, bang: string, innerValue: string) => {
    const parts = innerValue.split('|');
    const target = splitTarget(parts[0] ?? '');
    const display = parts.slice(1).join('|') || target.subpath || target.linkPath;
    const resolved = resolveForRender(options, `${target.linkPath}${target.subpath ? `#${target.subpath}` : ''}`);
    const attrs = `data-link-path="${escapeHtml(target.linkPath)}"${target.subpath ? ` data-subpath="${escapeHtml(target.subpath)}"` : ''}`;
    if (bang === '!' && resolved?.targetFileId && (resolved.targetKind ?? resolved.kind) === 'attachment' && options.attachmentUrl) {
      const src = safeHref(options.attachmentUrl(resolved.targetFileId));
      return src === null ? store(`<span class="tephra-unresolved" ${attrs}>${escapeHtml(display)}</span>`) : store(`<img src="${escapeHtml(src)}" alt="${escapeHtml(display)}" ${attrs}>`);
    }
    const state = resolved?.ambiguous ? 'tephra-ambiguous' : resolved?.unresolved ? 'tephra-unresolved' : 'tephra-link';
    const embed = bang === '!' ? ' data-embed="true"' : '';
    const fileAttr = resolved?.targetFileId ? ` data-file-id="${escapeHtml(resolved.targetFileId)}"` : '';
    const missingAttr = resolved && !resolved.targetFileId && resolved.unresolved ? ` data-unresolved-target="${escapeHtml(target.linkPath)}"` : '';
    return store(`<a href="#" class="${state}" ${attrs}${fileAttr}${missingAttr}${embed}>${escapeHtml(display)}</a>`);
  });
  output = output.replace(/(!?)\[([^\]\n]*)\]\(([^)\n]+)\)/g, (_raw, bang: string, label: string, destinationValue: string) => {
    const destination = destinationValue.trim().replace(/^<|>$/g, '');
    const href = safeHref(destination);
    if (href === null) return store(`<span class="tephra-unsafe-link">${escapeHtml(label)}</span>`);
    const external = /^[a-z][a-z\d+.-]*:/i.test(destination) || destination.startsWith('//');
    if (!external) {
      const target = splitTarget(destination);
      const resolved = resolveForRender(options, destination);
      const state = resolved?.ambiguous ? 'tephra-ambiguous' : resolved?.unresolved ? 'tephra-unresolved' : 'tephra-link';
      const fileAttr = resolved?.targetFileId ? ` data-file-id="${escapeHtml(resolved.targetFileId)}"` : '';
      const missingAttr = resolved && !resolved.targetFileId && resolved.unresolved ? ` data-unresolved-target="${escapeHtml(target.linkPath)}"` : '';
      return store(`<a href="#" class="${state}" data-link-path="${escapeHtml(target.linkPath)}"${target.subpath ? ` data-subpath="${escapeHtml(target.subpath)}"` : ''}${fileAttr}${missingAttr}>${escapeHtml(label)}</a>`);
    }
    if (bang === '!') return store(`<img src="${escapeHtml(href)}" alt="${escapeHtml(label)}">`);
    return store(`<a href="${escapeHtml(href)}" rel="noopener noreferrer">${escapeHtml(label)}</a>`);
  });
  output = escapeHtml(output)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return output.replace(/\uE000(\d+)\uE001/g, (_match, index: string) => tokens[Number(index)] ?? '');
}

type TableAlign = 'left' | 'center' | 'right' | null;

/** Split a GFM table row on unescaped pipes, stripping optional outer pipes.
 * Pipes inside `[[wikilinks|alias]]`, `[...]` link labels, and backtick code
 * spans do not split cells (Obsidian allows `|` aliases inside tables). */
function splitTableRow(line: string): string[] | null {
  const cells: string[] = [];
  let current = '';
  let escaped = false;
  let hasPipe = false;
  let inWiki = false;
  let bracketDepth = 0;
  let inCode = false;
  let index = 0;
  while (index < line.length) {
    const ch = line[index] ?? '';
    if (escaped) {
      current += ch === '|' ? '|' : `\\${ch}`;
      escaped = false;
      index += 1;
      continue;
    }
    if (ch === '\\') { escaped = true; index += 1; continue; }
    if (ch === '`') {
      let run = 1;
      while (line[index + run] === '`') run += 1;
      current += '`'.repeat(run);
      index += run;
      inCode = !inCode;
      continue;
    }
    if (!inCode) {
      if (!inWiki && ch === '[' && line[index + 1] === '[') {
        inWiki = true;
        current += '[[';
        index += 2;
        continue;
      }
      if (inWiki && ch === ']' && line[index + 1] === ']') {
        inWiki = false;
        current += ']]';
        index += 2;
        continue;
      }
      if (!inWiki) {
        if (ch === '[') bracketDepth += 1;
        else if (ch === ']' && bracketDepth > 0) bracketDepth -= 1;
      }
    }
    if (ch === '|' && !inWiki && !inCode && bracketDepth === 0) {
      hasPipe = true;
      cells.push(current);
      current = '';
      index += 1;
      continue;
    }
    current += ch;
    index += 1;
  }
  if (escaped) current += '\\';
  cells.push(current);
  if (!hasPipe) return null;
  if (cells.length > 0 && (cells[0] ?? '').trim() === '') cells.shift();
  if (cells.length > 0 && (cells[cells.length - 1] ?? '').trim() === '') cells.pop();
  return cells.map((cell) => cell.trim());
}

/** Parse a GFM delimiter row (`| --- | :---: | ---: |`). Returns null if invalid. */
function parseTableDelimiter(line: string): TableAlign[] | null {
  const cells = splitTableRow(line);
  if (!cells || cells.length === 0) return null;
  const aligns: TableAlign[] = [];
  for (const cell of cells) {
    const match = /^(:?)-+(:?)$/.exec(cell);
    if (!match) return null;
    const left = match[1] === ':';
    const right = match[2] === ':';
    aligns.push(left && right ? 'center' : right ? 'right' : left ? 'left' : null);
  }
  return aligns;
}

/** Obsidian callout type aliases map to their canonical type. */
const CALLOUT_ALIASES: Record<string, string> = {
  summary: 'abstract',
  tldr: 'abstract',
  hint: 'tip',
  important: 'tip',
  check: 'success',
  done: 'success',
  help: 'question',
  faq: 'question',
  caution: 'warning',
  attention: 'warning',
  fail: 'failure',
  missing: 'failure',
  error: 'danger',
  cite: 'quote',
};

const CALLOUT_TYPES = new Set([
  'note', 'abstract', 'info', 'todo', 'tip', 'success',
  'question', 'warning', 'failure', 'danger', 'bug', 'example', 'quote',
]);

const svgIcon = (paths: string): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

/** Minimal stroke icons (one per canonical callout type). Decorative only. */
const CALLOUT_ICONS: Record<string, string> = {
  note: svgIcon('<path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>'),
  abstract: svgIcon('<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4M12 16h4M8 11h.01M8 16h.01"/>'),
  info: svgIcon('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>'),
  todo: svgIcon('<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8M13 12h8M13 18h8"/>'),
  tip: svgIcon('<path d="M9 18h6M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.4 1 2.3h6c0-.9.4-1.8 1-2.3A7 7 0 0 0 12 2Z"/>'),
  success: svgIcon('<path d="M20 6 9 17l-5-5"/>'),
  question: svgIcon('<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01"/>'),
  warning: svgIcon('<path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3Z"/><path d="M12 9v4M12 17h.01"/>'),
  failure: svgIcon('<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/>'),
  danger: svgIcon('<path d="M13 2 3 14h7l-1 8 10-12h-7l1-8Z"/>'),
  bug: svgIcon('<path d="m8 2 1.5 2.5M16 2l-1.5 2.5M12 4v3"/><rect x="7" y="7" width="10" height="13" rx="5"/><path d="M4 10h3M4 15h3M20 10h-3M20 15h-3"/>'),
  example: svgIcon('<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/>'),
  quote: svgIcon('<path d="M10 7H6a2 2 0 0 0-2 2v7h7v-7H6.5A1.5 1.5 0 0 1 8 7.5V7h2Z"/><path d="M20 7h-4a2 2 0 0 0-2 2v7h7v-7h-4.5A1.5 1.5 0 0 1 18 7.5V7h2Z"/>'),
};

/**
 * Render an Obsidian callout (`> [!type] title`). The head match covers the
 * first quote line; bodyLines are the remaining stripped quote lines.
 * Unknown types fall back to `note` styling, like Obsidian.
 */
function renderCallout(head: RegExpExecArray, bodyLines: string[], options: MarkdownRenderOptions): string {
  const rawType = (head[1] ?? 'note').toLowerCase();
  const foldMarker = head[2] ?? '';
  const customTitle = (head[3] ?? '').trim();
  const canonical = CALLOUT_ALIASES[rawType] ?? rawType;
  const colorType = CALLOUT_TYPES.has(canonical) ? canonical : 'note';
  const title = customTitle !== ''
    ? customTitle
    : rawType.charAt(0).toUpperCase() + rawType.slice(1);
  const icon = CALLOUT_ICONS[colorType] ?? CALLOUT_ICONS.note ?? '';
  const titleInner = `<div class="callout-icon">${icon}</div><div class="callout-title-inner">${renderInline(title, options)}</div>`;
  const bodyHtml = renderBlocks(bodyLines, options).join('\n').trim();
  const content = bodyHtml === '' ? '' : `\n<div class="callout-content">\n${bodyHtml}\n</div>`;
  const attrs = `class="callout" data-callout="${escapeHtml(rawType)}"`;
  if (foldMarker !== '') {
    const open = foldMarker === '+' ? ' open' : '';
    return `<details ${attrs}${open}>\n<summary class="callout-title">${titleInner}</summary>${content}\n</details>`;
  }
  return `<div ${attrs}>\n<div class="callout-title">${titleInner}</div>${content}\n</div>`;
}

function renderBlocks(lines: string[], options: MarkdownRenderOptions): string[] {
  const html: string[] = [];
  let inFence = false;
  let fence = '';
  let code: string[] = [];
  let paragraph: string[] = [];
  let quoteBuffer: string[] = [];
  let listBuffer: Array<{ checked: boolean | null; content: string }> = [];
  const flushParagraph = (): void => {
    if (paragraph.length > 0) html.push(`<p>${renderInline(paragraph.join('\n'), options).replaceAll('\n', '<br>')}</p>`);
    paragraph = [];
  };
  const flushList = (): void => {
    if (listBuffer.length === 0) return;
    const hasTask = listBuffer.some((item) => item.checked !== null);
    const items = listBuffer.map((item) => {
      if (item.checked !== null) {
        const checkedAttr = item.checked ? ' checked' : '';
        return `<li class="task-list-item"><input type="checkbox" disabled${checkedAttr}> ${renderInline(item.content, options)}</li>`;
      }
      return `<li>${renderInline(item.content, options)}</li>`;
    }).join('\n');
    html.push(hasTask ? `<ul class="contains-task-list">\n${items}\n</ul>` : `<ul>\n${items}\n</ul>`);
    listBuffer = [];
  };
  const flushQuote = (): void => {
    if (quoteBuffer.length === 0) return;
    const head = /^\[!(\w[\w-]*)\]([+-]?)\s*(.*)$/.exec(quoteBuffer[0] ?? '');
    if (head) {
      html.push(renderCallout(head, quoteBuffer.slice(1), options));
    } else {
      const inner = renderBlocks(quoteBuffer, options).join('\n');
      if (inner.trim() !== '') html.push(`<blockquote>\n${inner}\n</blockquote>`);
    }
    quoteBuffer = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const quote = /^ {0,3}>\s?(.*)$/.exec(line);
    if (quote) {
      flushParagraph();
      flushList();
      quoteBuffer.push(quote[1] ?? '');
      continue;
    }
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!inFence) { flushParagraph(); flushQuote(); flushList(); inFence = true; fence = marker.charAt(0); code = []; }
      else if (marker.charAt(0) === fence) { html.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`); inFence = false; }
      continue;
    }
    if (inFence) { code.push(line); continue; }
    if (line.trim() === '') {
      if (quoteBuffer.length > 0) {
        flushList();
        quoteBuffer.push('');
      } else {
        flushParagraph();
        flushList();
      }
      continue;
    }
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      flushParagraph();
      flushQuote();
      flushList();
      const text = heading[2] ?? '';
      html.push(`<h${heading[1]?.length ?? 1} id="${escapeHtml(slugify(text))}">${renderInline(text, options)}</h${heading[1]?.length ?? 1}>`);
      continue;
    }
    const listMatch = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (listMatch) {
      flushParagraph();
      flushQuote();
      const rest = listMatch[1] ?? '';
      const task = /^\[([ xX])\]\s*(.*)$/.exec(rest);
      if (task) listBuffer.push({ checked: (task[1] ?? '').toLowerCase() === 'x', content: task[2] ?? '' });
      else listBuffer.push({ checked: null, content: rest });
      continue;
    }
    // GFM table: header row + delimiter row + consecutive body rows.
    if (line.includes('|') && index + 1 < lines.length) {
      const head = splitTableRow(line);
      const aligns = parseTableDelimiter(lines[index + 1] ?? '');
      if (head && aligns && head.length > 0 && head.length === aligns.length) {
        flushParagraph();
        flushQuote();
        flushList();
        const bodyRows: string[][] = [];
        let cursor = index + 2;
        while (cursor < lines.length) {
          const rowLine = lines[cursor] ?? '';
          if (rowLine.trim() === '') break;
          const row = splitTableRow(rowLine);
          if (!row) break;
          while (row.length < head.length) row.push('');
          bodyRows.push(row.slice(0, head.length));
          cursor += 1;
        }
        const alignAttr = (align: TableAlign): string => (align ? ` align="${align}"` : '');
        const thead = `<thead>\n<tr>\n${head.map((cell, cellIndex) => `<th${alignAttr(aligns[cellIndex] ?? null)}>${renderInline(cell, options)}</th>`).join('\n')}\n</tr>\n</thead>`;
        const tbody = bodyRows.length > 0
          ? `\n<tbody>\n${bodyRows.map((row) => `<tr>\n${row.map((cell, cellIndex) => `<td${alignAttr(aligns[cellIndex] ?? null)}>${renderInline(cell, options)}</td>`).join('\n')}\n</tr>`).join('\n')}\n</tbody>`
          : '';
        html.push(`<table>\n${thead}${tbody}\n</table>`);
        index = cursor - 1;
        continue;
      }
    }
    // Lazy continuation: a plain paragraph line directly after quote lines
    // belongs to the blockquote per CommonMark.
    if (quoteBuffer.length > 0) {
      flushList();
      quoteBuffer.push(line);
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  flushParagraph();
  flushQuote();
  flushList();
  if (inFence) html.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
  return html;
}

export async function renderMarkdown(options: MarkdownRenderOptions): Promise<RenderedNote> {
  const parsed = parseNote(options.markdown);
  const { body } = readFrontmatter(options.markdown);
  const lines = body.split('\n');
  const html = renderBlocks(lines, options);
  return { ...parsed, html: html.join('\n') };
}
