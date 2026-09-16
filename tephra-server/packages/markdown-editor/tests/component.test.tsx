// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { clearSessions } from '../src/session';
import { TephraEditor } from '../src/index';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

function editorText(container: HTMLElement): string | null {
  return container.querySelector('.cm-content')?.textContent ?? null;
}

describe('TephraEditor', () => {
  let container: HTMLElement;
  let root: Root | null;

  beforeEach(() => {
    ensureBrowserApis();
    clearSessions();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = null;
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = null;
    container.remove();
  });

  function render(node: ReactNode): void {
    if (!root) root = createRoot(container);
    act(() => root?.render(node));
  }

  it('mounts one editor showing the base text and reports clean', () => {
    const dirtyStates: boolean[] = [];
    render(
      <TephraEditor docKey="a" baseText="# hello" onDirtyChange={(dirty) => dirtyStates.push(dirty)} />,
    );
    expect(container.querySelectorAll('.cm-editor')).toHaveLength(1);
    expect(editorText(container)).toBe('# hello');
    expect(dirtyStates).toEqual([false]);
  });

  it('reloads the document when baseText changes for the same docKey', () => {
    const dirtyStates: boolean[] = [];
    render(
      <TephraEditor
        docKey="a"
        baseText="v1"
        onDirtyChange={(dirty) => dirtyStates.push(dirty)}
      />,
    );
    expect(editorText(container)).toBe('v1');
    render(
      <TephraEditor
        docKey="a"
        baseText="v2 from server"
        onDirtyChange={(dirty) => dirtyStates.push(dirty)}
      />,
    );
    expect(editorText(container)).toBe('v2 from server');
    expect(dirtyStates.at(-1)).toBe(false);
  });

  it('restores the cached session when remounting the same docKey', () => {
    const first: boolean[] = [];
    render(
      <TephraEditor docKey="a" baseText="base" onDirtyChange={(dirty) => first.push(dirty)} />,
    );
    expect(editorText(container)).toBe('base');
    // Unmount persists the session; remount with a different base must keep
    // the cached doc rather than clobbering it.
    act(() => root?.unmount());
    root = null;
    render(<TephraEditor docKey="a" baseText="stale base" />);
    expect(editorText(container)).toBe('base');
  });

  it('keeps per-docKey sessions isolated across switches', () => {
    render(<TephraEditor docKey="a" baseText="doc-a" />);
    expect(editorText(container)).toBe('doc-a');
    render(<TephraEditor docKey="b" baseText="doc-b" />);
    expect(editorText(container)).toBe('doc-b');
    render(<TephraEditor docKey="a" baseText="doc-a" />);
    expect(editorText(container)).toBe('doc-a');
  });
});
