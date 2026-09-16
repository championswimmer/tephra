// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { redo, undo } from '@codemirror/commands';
import { EditorView, keymap } from '@codemirror/view';
import { createTephraEditor, snapshotHistory, type TephraEditorHandle } from '../src/editor';

function ensureBrowserApis(): void {
  if (typeof window.requestAnimationFrame !== 'function') {
    window.requestAnimationFrame = ((cb: FrameRequestCallback): number =>
      window.setTimeout(() => cb(performance.now()), 0) as unknown as number) as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = ((id: number): void => {
      window.clearTimeout(id);
    }) as typeof window.cancelAnimationFrame;
  }
  if (typeof window.ResizeObserver !== 'function') {
    window.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
  }
}

describe('createTephraEditor', () => {
  let host: HTMLDivElement;
  let handles: TephraEditorHandle[];

  beforeEach(() => {
    ensureBrowserApis();
    host = document.createElement('div');
    document.body.appendChild(host);
    handles = [];
  });

  afterEach(() => {
    for (const handle of handles) handle.destroy();
    host.remove();
  });

  function create(
    options: Partial<Parameters<typeof createTephraEditor>[0]> & { initialDoc: string },
  ): TephraEditorHandle {
    const handle = createTephraEditor({ parent: host, ...options });
    handles.push(handle);
    return handle;
  }

  it('loads the initial doc and reports it back byte-identically', () => {
    const text = '# Title\n\nSome **bold** and `code`.\n';
    const handle = create({ initialDoc: text });
    expect(handle.getText()).toBe(text);
    expect(host.querySelector('.cm-editor')).not.toBeNull();
  });

  it('fires onChange with the new text on edits', () => {
    const seen: string[] = [];
    const handle = create({ initialDoc: 'hello', onChange: (text) => seen.push(text) });
    handle.setText('hello world');
    expect(handle.getText()).toBe('hello world');
    expect(seen).toEqual(['hello world']);
  });

  it('setText with identical text is a no-op (no change event)', () => {
    let calls = 0;
    const handle = create({ initialDoc: 'same', onChange: () => (calls += 1) });
    handle.setText('same');
    expect(calls).toBe(0);
  });

  it('routes the Mod-s binding to onSave with the current text', () => {
    let saved: string | undefined;
    const handle = create({
      initialDoc: 'to save',
      onSave: (text) => {
        saved = text;
      },
    });
    const bindings = handle.view.state.facet(keymap).flat();
    const saveBinding = bindings.find((binding) => binding.key === 'Mod-s');
    expect(saveBinding).toBeDefined();
    expect(saveBinding?.run?.(handle.view)).toBe(true);
    expect(saved).toBe('to save');
  });

  it('toggles editability via setReadOnly', () => {
    const handle = create({ initialDoc: 'x' });
    expect(handle.view.state.facet(EditorView.editable)).toBe(true);
    handle.setReadOnly(true);
    expect(handle.view.state.facet(EditorView.editable)).toBe(false);
    handle.setReadOnly(false);
    expect(handle.view.state.facet(EditorView.editable)).toBe(true);
  });

  it('starts read-only when constructed with readOnly', () => {
    const handle = create({ initialDoc: 'x', readOnly: true });
    expect(handle.view.state.facet(EditorView.editable)).toBe(false);
  });

  it('applies a dark theme without throwing', () => {
    const handle = create({ initialDoc: 'x', theme: 'dark' });
    handle.setTheme('light');
    handle.setTheme('dark');
    expect(handle.getText()).toBe('x');
  });

  it('restores undo history across handles via session snapshots', () => {
    const first = create({ initialDoc: 'hello' });
    first.view.dispatch({ changes: { from: 5, insert: ' world' } });
    expect(first.getText()).toBe('hello world');
    const snapshot = snapshotHistory(first.view);

    const secondHost = document.createElement('div');
    document.body.appendChild(secondHost);
    try {
      const second = createTephraEditor({
        parent: secondHost,
        initialDoc: 'hello world',
        initialHistory: snapshot,
      });
      handles.push(second);
      expect(undo(second.view)).toBe(true);
      expect(second.view.state.doc.toString()).toBe('hello');
      expect(redo(second.view)).toBe(true);
      expect(second.view.state.doc.toString()).toBe('hello world');
    } finally {
      secondHost.remove();
    }
  });
});
