import { ArrowLeftRight, Link2 } from 'lucide-react';
import type { NoteLink } from '../api/types';
function LinkList({
  title,
  icon,
  links,
  direction,
  onOpen,
}: {
  title: string;
  icon: typeof Link2;
  links: NoteLink[];
  direction: 'out' | 'in';
  onOpen: (id: string) => void;
}) {
  const Icon = icon;
  return (
    <section>
      <h3>
        <Icon size={14} aria-hidden="true" focusable="false" className="icon" />
        {title} <span>{links.length}</span>
      </h3>
      {links.length === 0 ? (
        <p className="muted">None</p>
      ) : (
        <ul>
          {links.map((link, index) => {
            const otherId = direction === 'in' ? link.sourceFileId : link.targetFileId;
            const otherPath = direction === 'in' ? link.sourcePath : link.targetPath;
            return (
              <li key={`${link.sourceFileId}-${link.targetFileId ?? 'missing'}-${index}`}>
                {otherId ? (
                  <button type="button" onClick={() => onOpen(otherId)}>
                    {otherPath ?? link.displayText ?? link.rawText ?? 'Note'}
                  </button>
                ) : (
                  <span title="Unresolved link">
                    {link.displayText ?? link.targetPath ?? link.rawText ?? 'Unresolved'}{' '}
                    <small>unresolved</small>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
export function LinksPanel({
  links,
  backlinks,
  onOpen,
  id,
}: {
  links: NoteLink[];
  backlinks: NoteLink[];
  onOpen: (id: string) => void;
  id?: string;
}) {
  return (
    <aside className="links-panel" aria-label="Note relationships" {...(id ? { id } : {})}>
      <LinkList title="Links" icon={Link2} links={links} direction="out" onOpen={onOpen} />
      <LinkList
        title="Backlinks"
        icon={ArrowLeftRight}
        links={backlinks}
        direction="in"
        onOpen={(id) => onOpen(id)}
      />
    </aside>
  );
}
