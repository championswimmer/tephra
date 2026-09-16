/**
 * React surface for the markdown editor: `<TephraEditor />`.
 *
 * The component owns one CodeMirror `EditorView` for its lifetime (per
 * `docKey`) and reconciles props into it imperatively. Changing `baseText`
 * for the same `docKey` is treated as a reload — applied only when the new
 * base differs from both the cached session doc and the live document, so a
 * server update never clobbers in-flight typing. Switching `docKey`
 * persists the outgoing session (doc, selection, scroll, undo history) and
 * restores the incoming one.
 */

import { useEffect, useRef } from 'react';
import {
  createTephraEditor,
  snapshotHistory,
  type TephraEditorHandle,
  type TephraTheme,
} from '../editor';
import { isDirty } from '../dirty';
import { restoreSession, saveSession, type SavedSelection } from '../session';

export interface TephraEditorProps {
  /** Stable key for session caching — use the vault file id. */
  docKey: string;
  /** Initial markdown. Changing `baseText` for the same docKey is a reload. */
  baseText: string;
  readOnly?: boolean | undefined;
  /** Fired on every change with the current dirty state. */
  onDirtyChange?: ((dirty: boolean) => void) | undefined;
  /** Cmd/Ctrl+S and the toolbar both route here. */
  onSave?: ((text: string) => void | Promise<void>) | undefined;
  theme?: TephraTheme | undefined;
}

function clampSelection(
  selection: SavedSelection | null,
  docLength: number,
): SavedSelection | null {
  if (!selection) return null;
  return {
    anchor: Math.max(0, Math.min(selection.anchor, docLength)),
    head: Math.max(0, Math.min(selection.head, docLength)),
  };
}

export function TephraEditor({
  docKey,
  baseText,
  readOnly = false,
  onDirtyChange,
  onSave,
  theme = 'light',
}: TephraEditorProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<TephraEditorHandle | null>(null);
  // The server base text the live document was loaded from; dirty state is
  // measured against this, not against the latest prop.
  const loadedBaseRef = useRef<string>(baseText);

  // Fresh callbacks without remounting the view.
  const callbacksRef = useRef({ onDirtyChange, onSave });
  callbacksRef.current = { onDirtyChange, onSave };
  const baseTextRef = useRef(baseText);
  baseTextRef.current = baseText;

  // Own one EditorView per docKey: restore the cached session on mount and
  // persist it on unmount or docKey switch.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const session = restoreSession(docKey);
    const initialDoc = session?.doc ?? baseTextRef.current;
    // Anchor dirty state to the server base, not the restored doc: a
    // restored session holding unsaved edits must read as dirty.
    loadedBaseRef.current = baseTextRef.current;
    const handle = createTephraEditor({
      parent: host,
      initialDoc,
      readOnly,
      theme,
      initialSelection: clampSelection(session?.selection ?? null, initialDoc.length),
      initialHistory: session?.history,
      onChange: (text) => {
        callbacksRef.current.onDirtyChange?.(isDirty(loadedBaseRef.current, text));
      },
      onSave: (text) => {
        void callbacksRef.current.onSave?.(text);
      },
    });
    if (session && session.scrollTop > 0) {
      handle.view.scrollDOM.scrollTop = session.scrollTop;
    }
    handleRef.current = handle;
    callbacksRef.current.onDirtyChange?.(isDirty(loadedBaseRef.current, initialDoc));
    return () => {
      handleRef.current = null;
      const main = handle.view.state.selection.main;
      saveSession(docKey, {
        doc: handle.view.state.doc.toString(),
        selection: { anchor: main.anchor, head: main.head },
        scrollTop: handle.view.scrollDOM.scrollTop,
        history: snapshotHistory(handle.view),
      });
      handle.destroy();
    };
    // Owned per docKey; readOnly/theme/baseText reconcile via effects below.
  }, [docKey]);

  // Reload: a new baseText for the same docKey replaces the document, but
  // only when it differs from both the cached session doc and the live doc
  // (so save echoes and already-loaded content never reset the cursor),
  // and only when the editor is clean — in-flight typing is never
  // clobbered; a dirty editor keeps local edits and the save path surfaces
  // the divergence as a conflict.
  useEffect(() => {
    const handle = handleRef.current;
    if (!handle) return;
    if (baseText === loadedBaseRef.current) return;
    const current = handle.view.state.doc.toString();
    const cached = restoreSession(docKey)?.doc;
    if (baseText === cached || baseText === current) {
      loadedBaseRef.current = baseText;
      callbacksRef.current.onDirtyChange?.(isDirty(baseText, current));
      return;
    }
    if (isDirty(loadedBaseRef.current, current)) return;
    handle.setText(baseText);
    loadedBaseRef.current = baseText;
    const main = handle.view.state.selection.main;
    saveSession(docKey, {
      doc: baseText,
      selection: { anchor: main.anchor, head: main.head },
      scrollTop: handle.view.scrollDOM.scrollTop,
      history: snapshotHistory(handle.view),
    });
    callbacksRef.current.onDirtyChange?.(false);
  }, [baseText, docKey]);

  useEffect(() => {
    handleRef.current?.setReadOnly(readOnly);
  }, [readOnly]);

  useEffect(() => {
    handleRef.current?.setTheme(theme);
  }, [theme]);

  return <div ref={hostRef} className="tephra-editor" style={{ width: '100%', height: '100%' }} />;
}
