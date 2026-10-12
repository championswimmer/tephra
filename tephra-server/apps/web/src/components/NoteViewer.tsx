import { useCallback, useEffect, useState } from 'react';
import { useBeforeUnload } from 'react-router-dom';
import { api } from '../api/client';
import type { RenderedNote, VaultFile } from '../api/types';
import { useTheme } from '../theme/ThemeContext';
import { EditPane } from './note/EditPane';
import { NoteToolbar } from './note/NoteToolbar';
import { RenderedArticle } from './note/RenderedArticle';
import { MAX_EDIT_BYTES } from './note/utils';
import type { Mode } from './note/utils';
import { useNoteEditSession } from './note/useNoteEditSession';
import { ErrorState, IndexPending, Loading } from './Status';

const READ_ONLY_NOTICE =
  'This note is larger than 1 MB, so it opens read-only. Editing large notes in the browser is not supported.';

export function NoteViewer({
  vaultId,
  fileId,
  onOpen,
  getPathForFileId,
  file,
  onSaved,
}: {
  vaultId: string;
  fileId: string;
  /** Navigate by vault-relative path (see `vault/path-url`). */
  onOpen: (path: string) => void;
  getPathForFileId?: (fileId: string) => string | undefined;
  /**
   * Workspace file record when known. Carries the runtime `blobHash` the
   * server sends (used as `If-Match`), plus kind/size for the edit gating
   * rules. Optional so existing call sites keep working.
   */
  file?: VaultFile;
  /** Called after a successful save so the workspace can refresh files/links. */
  onSaved?: () => void;
}) {
  const { theme } = useTheme();
  const [note, setNote] = useState<RenderedNote | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('rendered');
  const [error, setError] = useState<unknown>();
  const [unresolved, setUnresolved] = useState<string>();
  const session = useNoteEditSession({
    vaultId,
    fileId,
    file,
    setNote,
    setSource,
    onSaved,
  });

  const editableKind = !file || file.kind === 'markdown';
  const tooLarge =
    file !== undefined && file.kind === 'markdown' && file.size > MAX_EDIT_BYTES;
  const canEdit = editableKind && !tooLarge;

  async function load() {
    setNote(null);
    setSource(null);
    setMode('rendered');
    setError(undefined);
    setUnresolved(undefined);
    session.reset();
    try {
      setNote(await api.rendered(vaultId, fileId));
    } catch (caught) {
      setError(caught);
    }
  }
  useEffect(() => {
    void load();
  }, [vaultId, fileId]);

  // Guard tab close / reload while edits are unsaved. In-app navigation keeps
  // the editor session (TephraEditor restores doc + undo per docKey), so no
  // router-level block is needed beyond this.
  useBeforeUnload(
    useCallback(
      (event: BeforeUnloadEvent) => {
        if (session.dirty && mode === 'edit') event.preventDefault();
      },
      [session.dirty, mode],
    ),
  );

  /** Exact current bytes (UTF-8 decode, no line-ending normalization). */
  async function ensureSource(): Promise<string> {
    if (source !== null) return source;
    const text = await api.source(vaultId, fileId);
    setSource(text);
    return text;
  }

  async function enterMode(next: Mode) {
    if (next === mode) return;
    session.clearSaveError();
    if (next !== 'edit') {
      if (next === 'source') {
        try {
          await ensureSource();
        } catch (caught) {
          setError(caught);
          return;
        }
      }
      setMode(next);
      return;
    }
    // Entering edit: stage the exact bytes and anchor the save base
    // (bytes + hash for `If-Match`) before the editor mounts.
    try {
      const text = await ensureSource();
      if (new TextEncoder().encode(text).byteLength > MAX_EDIT_BYTES) {
        session.showLargeNotice();
        return;
      }
      await session.startSession(text);
      setMode('edit');
    } catch (caught) {
      setError(caught);
    }
  }

  if (error) return <ErrorState error={error} retry={() => void load()} />;
  if (!note) return <Loading label="Rendering note…" />;
  const { conflict } = session;
  return (
    <div className="note-view">
      <NoteToolbar
        title={note.title}
        mode={mode}
        canEdit={canEdit}
        onSelect={(next) => void enterMode(next)}
      />
      {tooLarge && (
        <p className="notice" role="status">
          {READ_ONLY_NOTICE}
        </p>
      )}
      {session.largeNotice && (
        <p className="notice" role="status">
          {READ_ONLY_NOTICE}
        </p>
      )}
      {note.indexPending && <IndexPending />}
      {unresolved && (
        <p className="notice" role="status">
          Note not found: {unresolved}
        </p>
      )}
      {mode === 'source' ? (
        source === null ? (
          <Loading label="Loading source…" />
        ) : (
          <pre className="raw-source">
            <code>{source}</code>
          </pre>
        )
      ) : mode === 'edit' && session.baseText !== null ? (
        <EditPane
          docKey={session.docKey}
          baseText={session.baseText}
          theme={theme.scheme === 'dark' ? 'dark' : 'light'}
          dirty={session.dirty}
          saving={session.saving}
          savedTick={session.savedTick}
          saveError={session.saveError}
          conflict={conflict}
          editorHostRef={session.editorHostRef}
          onDirtyChange={session.setDirty}
          onSave={(text) => void session.doSave(text)}
          onRequestSave={session.requestEditorSave}
          onOverwrite={() => {
            if (conflict) void session.doSave(conflict.localText, conflict.current.blobHash);
          }}
          onReload={() => void session.reloadServerVersion()}
          onDownloadCopy={session.downloadConflictedCopy}
          onDismissConflict={session.dismissConflict}
        />
      ) : mode === 'edit' ? (
        <Loading label="Loading editor…" />
      ) : (
        <RenderedArticle
          html={note.html}
          onOpen={onOpen}
          getPathForFileId={getPathForFileId}
          onUnresolved={setUnresolved}
        />
      )}
    </div>
  );
}
