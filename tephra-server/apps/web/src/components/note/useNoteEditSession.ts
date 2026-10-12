import { useCallback, useRef, useState } from 'react';
import { dropSession, isDirty, resolveConflict } from '@tephra/markdown-editor';
import type { ConflictOutcome } from '@tephra/markdown-editor';
import { ApiError, api, editConflictCurrent } from '../../api/client';
import type { RenderedNote, VaultFile } from '../../api/types';
import { conflictCopyName, downloadText, sha256Hex } from './utils';
import type { ConflictState } from './utils';

interface Options {
  vaultId: string;
  fileId: string;
  file: VaultFile | undefined;
  setNote: (note: RenderedNote) => void;
  setSource: (text: string) => void;
  onSaved: (() => void) | undefined;
}

/**
 * Edit-session state for a note: the save base (exact bytes + blob hash used
 * as `If-Match`), dirty/saving flags, and conflict handling.
 */
export function useNoteEditSession({
  vaultId,
  fileId,
  file,
  setNote,
  setSource,
  onSaved,
}: Options) {
  // Edit-session base: the exact bytes the editor was loaded from, plus the
  // blob hash they were saved under (the `If-Match` value).
  const [baseText, setBaseText] = useState<string | null>(null);
  const baseRef = useRef<{ text: string; hash: string; mtime: number } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedTick, setSavedTick] = useState(0);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [reloadSeq, setReloadSeq] = useState(0);
  const [largeNotice, setLargeNotice] = useState(false);
  const editorHostRef = useRef<HTMLDivElement | null>(null);
  const savingRef = useRef(false);

  // Stable per-file session key for TephraEditor's docKey cache; bumped on
  // conflict Reload so the discarded local session is dropped, not restored.
  const docKey = `${vaultId}:${fileId}:${reloadSeq}`;

  /** Clear everything when a note (re)loads. */
  function reset() {
    setBaseText(null);
    baseRef.current = null;
    setDirty(false);
    setSaving(false);
    savingRef.current = false;
    setSaveError(null);
    setConflict(null);
    setLargeNotice(false);
  }

  /** Anchor the save base to the exact bytes about to be edited. */
  async function startSession(text: string) {
    const hash = file?.blobHash ?? (await sha256Hex(text));
    baseRef.current = { text, hash, mtime: file?.mtime ?? 0 };
    setBaseText(text);
    setDirty(false);
  }

  const doSave = useCallback(
    async (text: string, ifMatchOverride?: string) => {
      const base = baseRef.current;
      if (!base || savingRef.current) return;
      // Client-side half of byte fidelity: unchanged text is never sent.
      if (!ifMatchOverride && !isDirty(base.text, text)) {
        setDirty(false);
        return;
      }
      savingRef.current = true;
      setSaving(true);
      setSaveError(null);
      try {
        const ifMatch = ifMatchOverride ?? base.hash;
        const response = await api.saveContent(vaultId, fileId, text, ifMatch);
        baseRef.current = { text, hash: response.blobHash, mtime: response.mtime };
        setBaseText(text);
        setDirty(false);
        setConflict(null);
        setSavedTick((tick) => tick + 1);
        try {
          setNote(await api.rendered(vaultId, fileId));
        } catch {
          // Render refresh is best-effort; the save already committed.
        }
        onSaved?.();
      } catch (caught) {
        const current = editConflictCurrent(caught);
        if (current && !ifMatchOverride) {
          try {
            const serverText = await api.source(vaultId, fileId);
            let outcome: ConflictOutcome | null = null;
            try {
              if (!isDirty(serverText, text)) {
                outcome = 'identical';
              } else {
                outcome = resolveConflict({
                  localHash: await sha256Hex(text),
                  // The edit was based on `base`; a remote mtime past it
                  // means someone saved after this session loaded.
                  localMtime: base.mtime,
                  remoteHash: current.blobHash,
                  remoteMtime: current.mtime,
                });
              }
            } catch {
              outcome = null;
            }
            setConflict({ current, serverText, localText: text, outcome });
          } catch {
            setSaveError(
              caught instanceof ApiError
                ? caught.message
                : 'Save failed: the file changed on the server.',
            );
          }
        } else if (caught instanceof ApiError) {
          setSaveError(caught.message);
        } else {
          setSaveError('Save failed: unable to reach the Tephra server.');
        }
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [fileId, vaultId, onSaved, setNote],
  );

  /**
   * Route the toolbar Save through the editor's own save keybinding so the
   * saved text is always the live document — never a stale or scraped copy.
   */
  function requestEditorSave() {
    const host = editorHostRef.current;
    const target =
      host?.querySelector('.cm-content') ??
      host?.querySelector('[data-tephra-editor-save-target]');
    if (!target) return;
    const mac =
      typeof navigator !== 'undefined' && /mac/i.test(navigator.platform ?? '');
    target.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 's',
        bubbles: true,
        cancelable: true,
        ...(mac ? { metaKey: true } : { ctrlKey: true }),
      }),
    );
  }

  async function reloadServerVersion() {
    if (!conflict) return;
    // Drop the conflicted local session so returning to this note restores
    // the server version, not the discarded edits.
    dropSession(docKey);
    baseRef.current = {
      text: conflict.serverText,
      hash: conflict.current.blobHash,
      mtime: conflict.current.mtime,
    };
    setSource(conflict.serverText);
    setBaseText(conflict.serverText);
    setDirty(false);
    setConflict(null);
    setSaveError(null);
    setReloadSeq((seq) => seq + 1);
    try {
      setNote(await api.rendered(vaultId, fileId));
    } catch {
      // Best-effort; the reload already applied locally.
    }
    onSaved?.();
  }

  function downloadConflictedCopy() {
    if (!conflict) return;
    downloadText(conflictCopyName(file?.path ?? 'note'), conflict.localText);
  }

  return {
    docKey,
    baseText,
    dirty,
    setDirty,
    saving,
    savedTick,
    saveError,
    clearSaveError: () => setSaveError(null),
    conflict,
    dismissConflict: () => setConflict(null),
    largeNotice,
    showLargeNotice: () => setLargeNotice(true),
    editorHostRef,
    reset,
    startSession,
    doSave,
    requestEditorSave,
    reloadServerVersion,
    downloadConflictedCopy,
  };
}
