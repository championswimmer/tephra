/**
 * `@tephra/markdown-editor`: a CodeMirror 6 markdown editor for the web app.
 * The document *is* the markdown string — there is no AST round-trip, so
 * `open → save` with no edits is byte-exact.
 */
export { TephraEditor } from './components/TephraEditor';
export type { TephraEditorProps } from './components/TephraEditor';
export { resolveConflict } from './pure';
export type { ConflictInput, ConflictOutcome } from './pure';
export { isDirty, shouldSave } from './dirty';
export type { SaveGate } from './dirty';
export {
  clearSessions,
  dropSession,
  restoreSession,
  saveSession,
  MAX_SESSIONS,
} from './session';
export type {
  EditorSessionState,
  SavedSelection,
  SaveSessionInput,
} from './session';
export { createTephraEditor, snapshotHistory } from './editor';
export type {
  CreateTephraEditorOptions,
  TephraEditorHandle,
  TephraTheme,
} from './editor';
export { markdownSupport, saveKeyBinding, tephraTheme } from './extensions';
