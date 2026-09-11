import type { RenderNode } from './model';

/**
 * The documented subset of Obsidian search supported by the graph view:
 * bare terms, "quoted phrases", `path:`, `file:`, `tag:#x`, `-` negation,
 * and implicit AND. Bare `#tag` is accepted as shorthand for `tag:#tag`.
 * Keep `docs/graph-search.md` in sync with this grammar.
 */
export type QueryClause =
  | { type: 'term'; value: string; negated: boolean }
  | { type: 'path'; value: string; negated: boolean }
  | { type: 'file'; value: string; negated: boolean }
  | { type: 'tag'; value: string; negated: boolean };

export interface ParsedQuery {
  clauses: QueryClause[];
  /** True when the input contained no clauses (matches everything). */
  empty: boolean;
}

const OPERATORS = ['path:', 'file:', 'tag:'] as const;

/** Tokenize, honouring double quotes so `path:"daily notes"` stays one token. */
export function tokenizeQuery(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quoted = false;
  let sawContent = false;
  for (const char of input) {
    if (quoted) {
      if (char === '"') quoted = false;
      else current += char;
    } else if (char === '"') {
      quoted = true;
      sawContent = true;
    } else if (/\s/.test(char)) {
      if (current.length > 0 || sawContent) tokens.push(current);
      current = '';
      sawContent = false;
    } else {
      current += char;
    }
  }
  // An unterminated quote simply runs to the end of the input.
  if (current.length > 0 || sawContent) tokens.push(current);
  return tokens;
}

export function parseQuery(input: string): ParsedQuery {
  const clauses: QueryClause[] = [];
  for (const raw of tokenizeQuery(input)) {
    let token = raw;
    let negated = false;
    while (token.startsWith('-') && token.length > 1) {
      negated = !negated;
      token = token.slice(1);
    }
    // A lone dash with no term carries no search intent.
    if (/^-+$/.test(token)) continue;
    const lowered = token.toLowerCase();
    const operator = OPERATORS.find((op) => lowered.startsWith(op));
    if (operator) {
      const value = token.slice(operator.length);
      if (value.length === 0) continue;
      const type = operator.slice(0, -1) as 'path' | 'file' | 'tag';
      clauses.push({
        type,
        value: type === 'tag' ? value.replace(/^#/, '') : value,
        negated,
      });
    } else if (token.startsWith('#') && token.length > 1) {
      clauses.push({ type: 'tag', value: token.slice(1), negated });
    } else if (token.length > 0) {
      clauses.push({ type: 'term', value: token, negated });
    }
  }
  return { clauses, empty: clauses.length === 0 };
}

/** Case-insensitive substring test. */
function contains(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function basename(path: string): string {
  return path.split('/').at(-1) ?? path;
}

function matchesTag(node: RenderNode, value: string): boolean {
  const needle = value.toLowerCase();
  if (node.tags.some((tag) => tag.toLowerCase() === needle)) return true;
  // Let the tag node itself match its own tag query.
  return node.kind === 'tag' && node.path.toLowerCase() === needle;
}

export function matchesClause(node: RenderNode, clause: QueryClause): boolean {
  const matched = (() => {
    switch (clause.type) {
      case 'term':
        return contains(node.path, clause.value) || contains(node.title ?? '', clause.value);
      case 'path':
        return contains(node.path, clause.value);
      case 'file':
        return contains(basename(node.path), clause.value);
      case 'tag':
        return matchesTag(node, clause.value);
    }
  })();
  return clause.negated ? !matched : matched;
}

/** Implicit AND over all clauses. An empty query matches everything. */
export function matchesQuery(node: RenderNode, query: ParsedQuery): boolean {
  return query.clauses.every((clause) => matchesClause(node, clause));
}
