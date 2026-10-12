export type TableAlign = 'left' | 'center' | 'right' | null;

/** Split a GFM table row on unescaped pipes, stripping optional outer pipes.
 * Pipes inside `[[wikilinks|alias]]`, `[...]` link labels, and backtick code
 * spans do not split cells (Obsidian allows `|` aliases inside tables). */
export function splitTableRow(line: string): string[] | null {
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
export function parseTableDelimiter(line: string): TableAlign[] | null {
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

