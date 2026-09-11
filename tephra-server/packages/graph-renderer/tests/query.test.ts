import { describe, expect, it } from 'vitest';

import type { RenderNode } from '../src/model';
import { matchesQuery, parseQuery, tokenizeQuery } from '../src/query';

const node = (overrides: Partial<RenderNode> = {}): RenderNode => ({
  id: 'a',
  path: 'folder/Alpha Note.md',
  title: 'Alpha Note',
  kind: 'note',
  tags: ['project', 'area/work'],
  degree: 0,
  ...overrides,
});

describe('tokenizeQuery', () => {
  it('splits on whitespace and keeps quoted phrases intact', () => {
    expect(tokenizeQuery('alpha beta')).toEqual(['alpha', 'beta']);
    expect(tokenizeQuery('"daily notes" gamma')).toEqual(['daily notes', 'gamma']);
    expect(tokenizeQuery('path:"my folder" x')).toEqual(['path:my folder', 'x']);
  });

  it('treats an unterminated quote as running to the end', () => {
    expect(tokenizeQuery('"unterminated phrase')).toEqual(['unterminated phrase']);
  });
});

describe('parseQuery', () => {
  it('parses bare terms and quoted phrases as term clauses', () => {
    expect(parseQuery('alpha "two words"').clauses).toEqual([
      { type: 'term', value: 'alpha', negated: false },
      { type: 'term', value: 'two words', negated: false },
    ]);
  });

  it('parses path:, file: and tag: operators', () => {
    expect(parseQuery('path:folder file:alpha tag:#project').clauses).toEqual([
      { type: 'path', value: 'folder', negated: false },
      { type: 'file', value: 'alpha', negated: false },
      { type: 'tag', value: 'project', negated: false },
    ]);
  });

  it('accepts bare #tag as tag shorthand', () => {
    expect(parseQuery('#project').clauses).toEqual([
      { type: 'tag', value: 'project', negated: false },
    ]);
  });

  it('parses negation on terms and operators', () => {
    expect(parseQuery('-alpha -tag:#project -path:secret').clauses).toEqual([
      { type: 'term', value: 'alpha', negated: true },
      { type: 'tag', value: 'project', negated: true },
      { type: 'path', value: 'secret', negated: true },
    ]);
  });

  it('reports empty queries and ignores operator-only tokens', () => {
    expect(parseQuery('').empty).toBe(true);
    expect(parseQuery('   ').empty).toBe(true);
    expect(parseQuery('path:').empty).toBe(true);
    expect(parseQuery('-').empty).toBe(true);
  });
});

describe('matchesQuery', () => {
  it('matches bare terms against path and title, case-insensitively', () => {
    expect(matchesQuery(node(), parseQuery('alpha'))).toBe(true);
    expect(matchesQuery(node(), parseQuery('FOLDER'))).toBe(true);
    expect(matchesQuery(node({ title: null }), parseQuery('note.md'))).toBe(true);
    expect(matchesQuery(node(), parseQuery('missing'))).toBe(false);
  });

  it('implements implicit AND across clauses', () => {
    expect(matchesQuery(node(), parseQuery('alpha folder'))).toBe(true);
    expect(matchesQuery(node(), parseQuery('alpha missing'))).toBe(false);
  });

  it('scopes path: to the whole path and file: to the basename', () => {
    expect(matchesQuery(node(), parseQuery('path:folder/alpha'))).toBe(true);
    expect(matchesQuery(node(), parseQuery('file:alpha note.md'))).toBe(true);
    expect(matchesQuery(node(), parseQuery('file:folder'))).toBe(false);
  });

  it('matches tags exactly (not by substring)', () => {
    expect(matchesQuery(node(), parseQuery('tag:#project'))).toBe(true);
    expect(matchesQuery(node(), parseQuery('tag:area/work'))).toBe(true);
    expect(matchesQuery(node(), parseQuery('tag:#proj'))).toBe(false);
    // Tag nodes match their own name.
    expect(
      matchesQuery(node({ kind: 'tag', path: 'project', tags: [] }), parseQuery('tag:#project')),
    ).toBe(true);
  });

  it('negates any clause type', () => {
    expect(matchesQuery(node(), parseQuery('-alpha'))).toBe(false);
    expect(matchesQuery(node(), parseQuery('-tag:#project'))).toBe(false);
    expect(matchesQuery(node(), parseQuery('-path:secret'))).toBe(true);
    expect(matchesQuery(node(), parseQuery('alpha -missing'))).toBe(true);
  });

  it('matches everything when the query is empty', () => {
    expect(matchesQuery(node(), parseQuery(''))).toBe(true);
  });
});
