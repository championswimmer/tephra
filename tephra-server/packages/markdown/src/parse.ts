import type { BlockInfo, HeadingInfo, ParsedLink, ParsedNote } from './types.js';
import { slugify, splitTarget } from './text.js';

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

export function readFrontmatter(markdown: string): { frontmatter: Record<string, unknown>; body: string; offset: number } {
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

