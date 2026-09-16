/**
 * Dirty tracking and save gating. Pure string logic — no DOM, no CodeMirror.
 * `shouldSave` is the client-side half of byte fidelity: unchanged text must
 * never be sent, so opening a note and saving with no keystrokes cannot
 * produce a revision.
 */

export function isDirty(baseText: string, currentText: string): boolean {
  return baseText !== currentText;
}

export interface SaveGate {
  baseText: string;
  currentText: string;
  saving: boolean;
}

export function shouldSave(state: SaveGate): boolean {
  if (state.saving) return false;
  return isDirty(state.baseText, state.currentText);
}
