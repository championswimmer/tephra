import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearSessions,
  dropSession,
  MAX_SESSIONS,
  restoreSession,
  saveSession,
} from '../src/session';

beforeEach(() => {
  clearSessions();
});

describe('session cache', () => {
  it('saves and restores doc, selection, and scroll', () => {
    expect(restoreSession('missing')).toBeUndefined();
    saveSession('note-a', {
      doc: '# hello',
      selection: { anchor: 2, head: 5 },
      scrollTop: 120,
      history: { marker: 'opaque-value' },
    });
    const restored = restoreSession('note-a');
    expect(restored?.doc).toBe('# hello');
    expect(restored?.selection).toEqual({ anchor: 2, head: 5 });
    expect(restored?.scrollTop).toBe(120);
    // Opaque history passes through untouched.
    expect(restored?.history).toEqual({ marker: 'opaque-value' });
  });

  it('defaults selection to null and scroll to zero', () => {
    saveSession('note-b', { doc: 'x' });
    expect(restoreSession('note-b')).toMatchObject({ doc: 'x', selection: null, scrollTop: 0 });
  });

  it('overwrites the previous session for the same key', () => {
    saveSession('note-c', { doc: 'v1' });
    saveSession('note-c', { doc: 'v2' });
    expect(restoreSession('note-c')?.doc).toBe('v2');
  });

  it('drops a single session without touching others', () => {
    saveSession('keep', { doc: 'keep' });
    saveSession('drop', { doc: 'drop' });
    dropSession('drop');
    expect(restoreSession('drop')).toBeUndefined();
    expect(restoreSession('keep')?.doc).toBe('keep');
  });

  it('evicts the least-recently-used entry past the cap of 20', () => {
    expect(MAX_SESSIONS).toBe(20);
    for (let i = 0; i < MAX_SESSIONS; i += 1) {
      saveSession(`note-${i}`, { doc: `doc-${i}` });
    }
    // Touch note-0 so note-1 becomes the eviction victim.
    expect(restoreSession('note-0')?.doc).toBe('doc-0');
    saveSession('note-new', { doc: 'new' });
    expect(restoreSession('note-0')?.doc).toBe('doc-0');
    expect(restoreSession('note-1')).toBeUndefined();
    expect(restoreSession('note-new')?.doc).toBe('new');
  });
});
