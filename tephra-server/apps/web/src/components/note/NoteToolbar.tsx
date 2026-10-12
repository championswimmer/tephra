import { Code, Eye, Pencil } from 'lucide-react';
import type { Mode } from './utils';

export function NoteToolbar({
  title,
  mode,
  canEdit,
  onSelect,
}: {
  title: string | null | undefined;
  mode: Mode;
  canEdit: boolean;
  onSelect: (mode: Mode) => void;
}) {
  return (
    <header className="note-toolbar">
      <h2>{title || 'Note'}</h2>
      <div className="note-toolbar-actions" role="group" aria-label="Note view">
        <button
          type="button"
          className="icon-button"
          aria-pressed={mode === 'rendered'}
          onClick={() => onSelect('rendered')}
        >
          <Eye size={14} aria-hidden="true" focusable="false" className="icon" />
          Rendered
        </button>
        <button
          type="button"
          className="icon-button"
          aria-pressed={mode === 'source'}
          onClick={() => onSelect('source')}
        >
          <Code size={14} aria-hidden="true" focusable="false" className="icon" />
          Raw source
        </button>
        {canEdit && (
          <button
            type="button"
            className="icon-button"
            aria-pressed={mode === 'edit'}
            onClick={() => onSelect('edit')}
          >
            <Pencil size={14} aria-hidden="true" focusable="false" className="icon" />
            Edit
          </button>
        )}
      </div>
    </header>
  );
}
