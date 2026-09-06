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
    const line = lines[index] ?? '';
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
  const compact = decodedEntities.replace(/[\u0000-\u0020]+/g, '').toLocaleLowerCase();
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
  const store = (html: string): string => `\u0000${String(tokens.push(html) - 1)}\u0000`;
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
    return store(`<a href="#" class="${state}" ${attrs}${embed}>${escapeHtml(display)}</a>`);
  });
  output = output.replace(/(!?)\[([^\]\n]*)\]\(([^)\n]+)\)/g, (_raw, bang: string, label: string, destinationValue: string) => {
    const destination = destinationValue.trim().replace(/^<|>$/g, '');
    const href = safeHref(destination);
    if (href === null) return store(`<span class="tephra-unsafe-link">${escapeHtml(label)}</span>`);
    const external = /^[a-z][a-z\d+.-]*:/i.test(destination) || destination.startsWith('//');
    if (!external) {
      const target = splitTarget(destination);
      return store(`<a href="#" class="tephra-link" data-link-path="${escapeHtml(target.linkPath)}"${target.subpath ? ` data-subpath="${escapeHtml(target.subpath)}"` : ''}>${escapeHtml(label)}</a>`);
    }
    if (bang === '!') return store(`<img src="${escapeHtml(href)}" alt="${escapeHtml(label)}">`);
    return store(`<a href="${escapeHtml(href)}" rel="noopener noreferrer">${escapeHtml(label)}</a>`);
  });
  output = escapeHtml(output)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return output.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => tokens[Number(index)] ?? '');
}

export async function renderMarkdown(options: MarkdownRenderOptions): Promise<RenderedNote> {
  const parsed = parseNote(options.markdown);
  const { body } = readFrontmatter(options.markdown);
  const lines = body.split('\n');
  const html: string[] = [];
  let inFence = false;
  let fence = '';
  let code: string[] = [];
  let paragraph: string[] = [];
  const flushParagraph = (): void => {
    if (paragraph.length > 0) html.push(`<p>${renderInline(paragraph.join('\n'), options).replaceAll('\n', '<br>')}</p>`);
    paragraph = [];
  };
  for (const line of lines) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!inFence) { flushParagraph(); inFence = true; fence = marker.charAt(0); code = []; }
      else if (marker.charAt(0) === fence) { html.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`); inFence = false; }
      continue;
    }
    if (inFence) { code.push(line); continue; }
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) { flushParagraph(); const text = heading[2] ?? ''; html.push(`<h${heading[1]?.length ?? 1} id="${escapeHtml(slugify(text))}">${renderInline(text, options)}</h${heading[1]?.length ?? 1}>`); continue; }
    if (line.trim() === '') { flushParagraph(); continue; }
    const list = /^\s*[-*+]\s+(?:\[([ xX])\]\s+)?(.+)$/.exec(line);
    if (list) { flushParagraph(); const checkbox = list[1] === undefined ? '' : `<input type="checkbox" disabled${list[1].toLowerCase() === 'x' ? ' checked' : ''}> `; html.push(`<ul><li>${checkbox}${renderInline(list[2] ?? '', options)}</li></ul>`); continue; }
    paragraph.push(line);
  }
  flushParagraph();
  if (inFence) html.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
  return { ...parsed, html: html.join('\n') };
}
