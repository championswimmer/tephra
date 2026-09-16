import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useBeforeUnload } from 'react-router-dom';
import { Code, Eye, Pencil } from 'lucide-react';
import { TephraEditor, dropSession, isDirty, resolveConflict } from '@tephra/markdown-editor';
import type { ConflictOutcome } from '@tephra/markdown-editor';
import { ApiError, api, editConflictCurrent } from '../api/client';
import type { EditConflictCurrent, RenderedNote, VaultFile } from '../api/types';
import { useTheme } from '../theme/ThemeContext';
import { ErrorState, IndexPending, Loading } from './Status';

/** Markdown files larger than this open read-only; the editor stays off. */
export const MAX_EDIT_BYTES = 1024 * 1024;

type Mode = 'rendered' | 'source' | 'edit';

interface ConflictState {
  /** Server state from the 409 response. */
  current: EditConflictCurrent;
  /** Fresh server bytes fetched after the conflict. */
  serverText: string;
  /** Local text that was rejected. */
  localText: string;
  /** Suggestion from `resolveConflict`; null when it could not be computed. */
  outcome: ConflictOutcome | null;
}

function containServerHtml(html: string): string {
  const documentNode = new DOMParser().parseFromString(html, 'text/html');
  documentNode
    .querySelectorAll('script, iframe, object, embed, form, base, meta')
    .forEach((node) => node.remove());
  documentNode.querySelectorAll('*').forEach((element) => {
    for (const attribute of [...element.attributes]) {
      if (attribute.name.toLowerCase().startsWith('on')) element.removeAttribute(attribute.name);
      if (
        (attribute.name === 'href' || attribute.name === 'src') &&
        /^\s*javascript:/i.test(attribute.value)
      )
        element.removeAttribute(attribute.name);
    }
  });
  return documentNode.body.innerHTML;
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function conflictCopyName(path: string, now: Date = new Date()): string {
  const stem = path.split('/').pop() ?? 'note';
  const base = stem.toLowerCase().endsWith('.md') ? stem.slice(0, -3) : stem;
  const day = now.toISOString().slice(0, 10);
  return `${base} (web conflicted copy, ${day}).md`;
}

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
    setBaseText(null);
    baseRef.current = null;
    setDirty(false);
    setSaving(false);
    savingRef.current = false;
    setSaveError(null);
    setConflict(null);
    setLargeNotice(false);
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
        if (dirty && mode === 'edit') event.preventDefault();
      },
      [dirty, mode],
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
    setSaveError(null);
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
        setLargeNotice(true);
        return;
      }
      const hash = file?.blobHash ?? (await sha256Hex(text));
      baseRef.current = { text, hash, mtime: file?.mtime ?? 0 };
      setBaseText(text);
      setDirty(false);
      setMode('edit');
    } catch (caught) {
      setError(caught);
    }
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
    [fileId, vaultId, onSaved],
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
    const name = conflictCopyName(file?.path ?? 'note');
    const blob = new Blob([conflict.localText], { type: 'text/markdown; charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  const containedHtml = useMemo(() => (note ? containServerHtml(note.html) : ''), [note]);
  if (error) return <ErrorState error={error} retry={() => void load()} />;
  if (!note) return <Loading label="Rendering note…" />;
  return (
    <div className="note-view">
      <header className="note-toolbar">
        <h2>{note.title || 'Note'}</h2>
        <div className="note-toolbar-actions" role="group" aria-label="Note view">
          <button
            type="button"
            className="icon-button"
            aria-pressed={mode === 'rendered'}
            onClick={() => void enterMode('rendered')}
          >
            <Eye size={14} aria-hidden="true" focusable="false" className="icon" />
            Rendered
          </button>
          <button
            type="button"
            className="icon-button"
            aria-pressed={mode === 'source'}
            onClick={() => void enterMode('source')}
          >
            <Code size={14} aria-hidden="true" focusable="false" className="icon" />
            Raw source
          </button>
          {canEdit && (
            <button
              type="button"
              className="icon-button"
              aria-pressed={mode === 'edit'}
              onClick={() => void enterMode('edit')}
            >
              <Pencil size={14} aria-hidden="true" focusable="false" className="icon" />
              Edit
            </button>
          )}
        </div>
      </header>
      {tooLarge && (
        <p className="notice" role="status">
          This note is larger than 1 MB, so it opens read-only. Editing large notes in the
          browser is not supported.
        </p>
      )}
      {largeNotice && (
        <p className="notice" role="status">
          This note is larger than 1 MB, so it opens read-only. Editing large notes in the
          browser is not supported.
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
      ) : mode === 'edit' && baseText !== null ? (
        <EditPane
          docKey={docKey}
          baseText={baseText}
          theme={theme.scheme === 'dark' ? 'dark' : 'light'}
          dirty={dirty}
          saving={saving}
          savedTick={savedTick}
          saveError={saveError}
          conflict={conflict}
          editorHostRef={editorHostRef}
          onDirtyChange={setDirty}
          onSave={(text) => void doSave(text)}
          onRequestSave={requestEditorSave}
          onOverwrite={() => {
            if (conflict) void doSave(conflict.localText, conflict.current.blobHash);
          }}
          onReload={() => void reloadServerVersion()}
          onDownloadCopy={downloadConflictedCopy}
          onDismissConflict={() => setConflict(null)}
        />
      ) : mode === 'edit' ? (
        <Loading label="Loading editor…" />
      ) : (
        <article
          className="rendered-note"
          onClick={(event) => {
            const link = (event.target as HTMLElement).closest<HTMLAnchorElement>('a');
            if (!link) return;
            const unresolvedTarget =
              link.dataset.unresolvedTarget ??
              link.dataset.tephraUnresolved ??
              (link.classList.contains('tephra-unresolved')
                ? (link.dataset.linkPath ?? 'unknown note')
                : undefined);
            if (unresolvedTarget) {
              event.preventDefault();
              setUnresolved(unresolvedTarget);
              return;
            }
            const target = link.dataset.fileId ?? link.dataset.tephraFileId;
            const pathTarget = link.getAttribute('href')?.match(/\/file\/([^/?#]+)/)?.[1];
            const targetId = target ?? (pathTarget ? decodeURIComponent(pathTarget) : undefined);
            if (targetId) {
              event.preventDefault();
              // Server-rendered anchors carry file ids; navigation is by
              // path, so translate through the workspace's file list.
              const targetPath = getPathForFileId?.(targetId);
              if (targetPath !== undefined) onOpen(targetPath);
              else setUnresolved(targetId);
            } else if (link.getAttribute('href') === '#') {
              // Internal vault link the renderer could not resolve to a file
              // (e.g. ambiguous). Swallow the jump-to-top instead of navigating.
              event.preventDefault();
            }
          }}
          dangerouslySetInnerHTML={{ __html: containedHtml }}
        />
      )}
    </div>
  );
}

function EditPane({
  docKey,
  baseText,
  theme,
  dirty,
  saving,
  savedTick,
  saveError,
  conflict,
  editorHostRef,
  onDirtyChange,
  onSave,
  onRequestSave,
  onOverwrite,
  onReload,
  onDownloadCopy,
  onDismissConflict,
}: {
  docKey: string;
  baseText: string;
  theme: 'light' | 'dark';
  dirty: boolean;
  saving: boolean;
  savedTick: number;
  saveError: string | null;
  conflict: ConflictState | null;
  editorHostRef: React.RefObject<HTMLDivElement | null>;
  onDirtyChange: (dirty: boolean) => void;
  onSave: (text: string) => void;
  onRequestSave: () => void;
  onOverwrite: () => void;
  onReload: () => void;
  onDownloadCopy: () => void;
  onDismissConflict: () => void;
}) {
  return (
    <div className="note-editor">
      <div className="note-editor-bar">
        <span className="note-editor-status" role="status">
          {saving ? 'Saving…' : dirty ? 'Unsaved changes' : savedTick > 0 ? 'Saved' : 'No changes'}
        </span>
        <button
          type="button"
          className="icon-button"
          disabled={!dirty || saving}
          onClick={onRequestSave}
          title="Save (Ctrl/Cmd+S)"
        >
          Save
        </button>
      </div>
      {saveError && (
        <p className="notice notice-error" role="alert">
          {saveError}
        </p>
      )}
      {conflict && (
        <div className="conflict-banner" role="alert">
          <strong>Someone else saved this note first.</strong>
          <p>
            {conflict.outcome === 'identical'
              ? 'The server version is identical to your edits — reloading is lossless.'
              : conflict.outcome === 'remote-wins'
                ? 'The server version is newer. Reloading keeps their changes; overwriting keeps yours.'
                : conflict.outcome === 'local-wins'
                  ? 'Your edits are based on the latest version. Overwriting is safe.'
                  : 'Your edits are safe in the editor below. Choose how to resolve.'}{' '}
            Your text stays in the editor until you decide.
          </p>
          <div className="conflict-actions">
            <button type="button" className="icon-button" onClick={onReload}>
              Reload server version
            </button>
            <button
              type="button"
              className="icon-button"
              disabled={saving}
              onClick={onOverwrite}
            >
              Overwrite with my version
            </button>
            <button type="button" className="icon-button" onClick={onDownloadCopy}>
              Download conflicted copy
            </button>
            <button type="button" className="icon-button" onClick={onDismissConflict}>
              Keep editing
            </button>
          </div>
        </div>
      )}
      <div ref={editorHostRef} className="note-editor-host">
        <TephraEditor
          docKey={docKey}
          baseText={baseText}
          onDirtyChange={onDirtyChange}
          onSave={onSave}
          theme={theme}
        />
      </div>
    </div>
  );
}
