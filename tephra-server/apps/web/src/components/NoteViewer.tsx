import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import type { RenderedNote } from '../api/types';
import { ErrorState, IndexPending, Loading } from './Status';

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

export function NoteViewer({
  vaultId,
  fileId,
  onOpen,
}: {
  vaultId: string;
  fileId: string;
  onOpen: (id: string) => void;
}) {
  const [note, setNote] = useState<RenderedNote | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [raw, setRaw] = useState(false);
  const [error, setError] = useState<unknown>();
  const [unresolved, setUnresolved] = useState<string>();
  async function load() {
    setNote(null);
    setSource(null);
    setError(undefined);
    setUnresolved(undefined);
    setRaw(false);
    try {
      setNote(await api.rendered(vaultId, fileId));
    } catch (caught) {
      setError(caught);
    }
  }
  useEffect(() => {
    void load();
  }, [vaultId, fileId]);
  async function toggleRaw() {
    if (!raw && source === null) {
      try {
        setSource(await api.source(vaultId, fileId));
      } catch (caught) {
        setError(caught);
        return;
      }
    }
    setRaw(!raw);
  }
  const containedHtml = useMemo(() => (note ? containServerHtml(note.html) : ''), [note]);
  if (error) return <ErrorState error={error} retry={() => void load()} />;
  if (!note) return <Loading label="Rendering note…" />;
  return (
    <div className="note-view">
      <header className="note-toolbar">
        <h2>{note.title || 'Note'}</h2>
        <button type="button" aria-pressed={raw} onClick={() => void toggleRaw()}>
          {raw ? 'Rendered' : 'Raw source'}
        </button>
      </header>
      {note.indexPending && <IndexPending />}
      {unresolved && (
        <p className="notice" role="status">
          Note not found: {unresolved}
        </p>
      )}
      {raw ? (
        source === null ? (
          <Loading label="Loading source…" />
        ) : (
          <pre className="raw-source">
            <code>{source}</code>
          </pre>
        )
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
            if (target) {
              event.preventDefault();
              onOpen(target);
            } else if (pathTarget) {
              event.preventDefault();
              onOpen(decodeURIComponent(pathTarget));
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
