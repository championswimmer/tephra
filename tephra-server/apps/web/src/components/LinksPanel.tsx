import type { NoteLink } from '../api/types';
function LinkList({
  title,
  links,
  onOpen,
}: {
  title: string;
  links: NoteLink[];
  onOpen: (id: string) => void;
}) {
  return (
    <section>
      <h3>
        {title} <span>{links.length}</span>
      </h3>
      {links.length === 0 ? (
        <p className="muted">None</p>
      ) : (
        <ul>
          {links.map((link, index) => (
            <li key={`${link.sourceFileId}-${link.targetFileId ?? 'missing'}-${index}`}>
              {link.targetFileId ? (
                <button type="button" onClick={() => onOpen(link.targetFileId!)}>
                  {link.displayText ?? link.targetPath ?? link.sourcePath ?? link.rawText ?? 'Note'}
                </button>
              ) : (
                <span title="Unresolved link">
                  {link.displayText ?? link.targetPath ?? link.rawText ?? 'Unresolved'}{' '}
                  <small>unresolved</small>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
export function LinksPanel({
  links,
  backlinks,
  onOpen,
}: {
  links: NoteLink[];
  backlinks: NoteLink[];
  onOpen: (id: string) => void;
}) {
  return (
    <aside className="links-panel" aria-label="Note relationships">
      <LinkList title="Links" links={links} onOpen={onOpen} />
      <LinkList title="Backlinks" links={backlinks} onOpen={(id) => onOpen(id)} />
    </aside>
  );
}
