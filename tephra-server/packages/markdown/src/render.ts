import { renderCallout } from './callout.js';
import { renderInline } from './inline.js';
import { parseNote, readFrontmatter } from './parse.js';
import { parseTableDelimiter, splitTableRow, type TableAlign } from './table.js';
import { escapeHtml, slugify } from './text.js';
import type { MarkdownRenderOptions, RenderedNote } from './types.js';

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
      html.push(renderCallout(head, quoteBuffer.slice(1), {
        inline: (value) => renderInline(value, options),
        blocks: (blockLines) => renderBlocks(blockLines, options),
      }));
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
