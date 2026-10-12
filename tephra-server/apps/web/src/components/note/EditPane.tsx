import { TephraEditor } from '@tephra/markdown-editor';
import type { ConflictState } from './utils';

export function EditPane({
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
