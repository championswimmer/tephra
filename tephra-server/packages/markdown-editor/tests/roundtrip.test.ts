/**
 * Byte-fidelity round trip (invariant I2): loading every markdown file from
 * the `@tephra/test-fixtures` vault into the editor document and reading it
 * back must produce byte-identical content. DOM-free — the read-back goes
 * through `EditorState`, the same document the `EditorView` owns.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { EditorState } from '@codemirror/state';
import { markdownSupport } from '../src/extensions';
import { history } from '@codemirror/commands';

const VAULT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'test-fixtures',
  'vault',
);

function listMarkdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listMarkdownFiles(full));
    } else if (entry.endsWith('.md')) {
      out.push(full);
    }
  }
  return out.sort();
}

function loadAndReadBack(text: string): string {
  const state = EditorState.create({
    doc: text,
    extensions: [markdownSupport(), history()],
  });
  return state.doc.toString();
}

describe('byte-fidelity round trip over the fixture vault', () => {
  const files = listMarkdownFiles(VAULT_DIR);

  it('finds fixture markdown files', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const name = file.slice(VAULT_DIR.length + 1);
    it(`round-trips ${name} byte-identically`, () => {
      const original = readFileSync(file, 'utf8');
      expect(loadAndReadBack(original)).toBe(original);
    });
  }

  it('preserves adversarial constructs (fences, tables, entities, unicode)', () => {
    const tricky = [
      '```\n```nested?\n```\n',
      '| a | b |\n|---|---|\n| 1 | 2 \\| 3 |\n',
      'AT&T &amp; &#169; \u65e5\u672c\u8a9e Caf\u00e9\n',
      '---\ntitle: front & matter: [x]\n---\nbody\n',
      '> [!note] callout\n> ```js\n> code();\n> ```\n',
      '- [ ] task\n- [x] done\n',
      'line one\n\n\n\nline two\n',
    ];
    for (const text of tricky) {
      expect(loadAndReadBack(text)).toBe(text);
    }
  });
});
