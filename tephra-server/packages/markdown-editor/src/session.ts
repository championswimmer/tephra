/**
 * Per-file editor session cache, keyed by docKey (the vault file id).
 * Holds the live doc plus cursor, scroll, and undo history so switching
 * notes and coming back restores the editing session.
 *
 * DOM-free by construction: the selection is stored as plain JSON and the
 * scroll position as a number. The undo history snapshot is an opaque,
 * memory-only value produced and consumed by `editor.ts` — it is never
 * serialized. The whole cache is memory-only and dropped on vault change
 * via `clearSessions()`.
 */

export interface SavedSelection {
  anchor: number;
  head: number;
}

export interface EditorSessionState {
  doc: string;
  selection: SavedSelection | null;
  scrollTop: number;
  /** Opaque undo-history snapshot. Memory-only, never serialized. */
  history: unknown;
}

export interface SaveSessionInput {
  doc: string;
  selection?: SavedSelection | null | undefined;
  scrollTop?: number | undefined;
  history?: unknown;
}

/** LRU cap: at most this many per-file sessions are retained. */
export const MAX_SESSIONS = 20;

const sessions = new Map<string, EditorSessionState>();

export function saveSession(docKey: string, state: SaveSessionInput): void {
  // Delete-then-set refreshes recency for the LRU order.
  sessions.delete(docKey);
  sessions.set(docKey, {
    doc: state.doc,
    selection: state.selection ?? null,
    scrollTop: state.scrollTop ?? 0,
    history: state.history,
  });
  while (sessions.size > MAX_SESSIONS) {
    const oldest = sessions.keys().next();
    if (oldest.done) break;
    sessions.delete(oldest.value);
  }
}

export function restoreSession(docKey: string): EditorSessionState | undefined {
  const found = sessions.get(docKey);
  if (!found) return undefined;
  // Refresh recency on access.
  sessions.delete(docKey);
  sessions.set(docKey, found);
  return { ...found };
}

export function dropSession(docKey: string): void {
  sessions.delete(docKey);
}

export function clearSessions(): void {
  sessions.clear();
}
