/** Minimal strict unified-diff applier for MCP `update_note`. */

export class PatchError extends Error {}

interface Hunk {
  oldStart: number;
  oldLines: string[];
  newLines: string[];
}

function parseHunks(patch: string): Hunk[] {
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  for (const line of lines) {
    const header = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
    if (header) {
      current = { oldStart: Number(header[1]), oldLines: [], newLines: [] };
      hunks.push(current);
      continue;
    }
    if (current === null) continue; // file headers (---/+++/diff/index) before the first hunk
    if (line.startsWith('\\')) continue; // "\ No newline at end of file"
    const marker = line[0];
    const text = line.slice(1);
    if (marker === '-') current.oldLines.push(text);
    else if (marker === '+') current.newLines.push(text);
    else if (marker === ' ') {
      current.oldLines.push(text);
      current.newLines.push(text);
    } else if (line === '') {
      // Blank context line whose leading space was stripped by the sender.
      current.oldLines.push('');
      current.newLines.push('');
    } else throw new PatchError(`Unrecognised patch line: ${JSON.stringify(line.slice(0, 40))}`);
  }
  if (hunks.length === 0) throw new PatchError('Patch contains no "@@ -a,b +c,d @@" hunks.');
  return hunks;
}

function matchesAt(source: string[], at: number, expected: string[]): boolean {
  if (at < 0 || at + expected.length > source.length) return false;
  return expected.every((line, index) => source[at + index] === line);
}

/**
 * Applies a unified diff. Context and removed lines must match the source
 * exactly; line numbers are only a hint (the closest exact match wins), so
 * small offsets from earlier edits are tolerated but nothing is guessed.
 */
export function applyUnifiedDiff(source: string, patch: string): string {
  const lines = source.split('\n');
  let drift = 0;
  let cursor = 0;
  for (const [index, hunk] of parseHunks(patch).entries()) {
    const hint = Math.max(0, hunk.oldStart - 1 + drift);
    let at = -1;
    if (hunk.oldLines.length === 0) {
      at = Math.min(hunk.oldStart + drift, lines.length); // pure insertion: after line oldStart
    } else {
      let best = Infinity;
      for (let candidate = cursor; candidate + hunk.oldLines.length <= lines.length; candidate++) {
        if (matchesAt(lines, candidate, hunk.oldLines) && Math.abs(candidate - hint) < best) {
          best = Math.abs(candidate - hint);
          at = candidate;
        }
      }
    }
    if (at < 0 || at < cursor)
      throw new PatchError(
        `Hunk ${index + 1} does not apply: its context/removed lines were not found in the current note. Re-read the note and regenerate the patch.`,
      );
    lines.splice(at, hunk.oldLines.length, ...hunk.newLines);
    drift = at + hunk.newLines.length - (hunk.oldStart - 1 + hunk.oldLines.length);
    cursor = at + hunk.newLines.length;
  }
  return lines.join('\n');
}
