/**
 * CodeMirror 6 EditorView construction. The document *is* the markdown
 * string — there is no AST round-trip, so loading a note and reading it back
 * with no edits is byte-exact.
 */

import { defaultKeymap, history, historyField, historyKeymap } from '@codemirror/commands';
import { searchKeymap } from '@codemirror/search';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import {
  markdownSupport,
  saveKeyBinding,
  tephraTheme,
  type TephraTheme,
} from './extensions';
import type { SavedSelection } from './session';

export type { TephraTheme };

export interface CreateTephraEditorOptions {
  parent: HTMLElement;
  initialDoc: string;
  readOnly?: boolean | undefined;
  theme?: TephraTheme | undefined;
  initialSelection?: SavedSelection | null | undefined;
  /** Opaque memory-only undo-history snapshot from `session.ts`. */
  initialHistory?: unknown;
  onChange?: ((text: string) => void) | undefined;
  onSave?: ((text: string) => void | Promise<void>) | undefined;
}

export interface TephraEditorHandle {
  readonly view: EditorView;
  setReadOnly(readOnly: boolean): void;
  setTheme(theme: TephraTheme): void;
  getText(): string;
  setText(text: string): void;
  destroy(): void;
}

export function snapshotHistory(view: EditorView): unknown {
  return view.state.field(historyField, false);
}

export function createTephraEditor(options: CreateTephraEditorOptions): TephraEditorHandle {
  const editableCompartment = new Compartment();
  const themeCompartment = new Compartment();

  // Built eagerly so the save binding always sees the current document;
  // the `onSave` prop itself is read through at call time via closure over
  // `options`, so no rebinding is needed when it changes.
  const viewRef: { current: EditorView | null } = { current: null };
  const fireSave = (): void => {
    const current = viewRef.current;
    if (current) void options.onSave?.(current.state.doc.toString());
  };

  const extensions: Extension[] = [
    markdownSupport(),
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
    saveKeyBinding(fireSave),
    editableCompartment.of(EditorView.editable.of(!(options.readOnly ?? false))),
    themeCompartment.of(tephraTheme(options.theme ?? 'light')),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) options.onChange?.(update.state.doc.toString());
    }),
  ];

  if (options.initialHistory !== undefined) {
    const snapshot = options.initialHistory;
    extensions.push(historyField.init(() => snapshot as never));
  }

  const savedSelection = options.initialSelection;
  const state = EditorState.create({
    doc: options.initialDoc,
    ...(savedSelection
      ? { selection: { anchor: savedSelection.anchor, head: savedSelection.head } }
      : {}),
    extensions,
  });
  const view = new EditorView({ state, parent: options.parent });
  viewRef.current = view;

  return {
    view,
    setReadOnly(readOnly: boolean): void {
      view.dispatch({
        effects: editableCompartment.reconfigure(EditorView.editable.of(!readOnly)),
      });
    },
    setTheme(theme: TephraTheme): void {
      view.dispatch({
        effects: themeCompartment.reconfigure(tephraTheme(theme)),
      });
    },
    getText(): string {
      return view.state.doc.toString();
    },
    setText(text: string): void {
      if (view.state.doc.toString() === text) return;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
      });
    },
    destroy(): void {
      view.destroy();
    },
  };
}
