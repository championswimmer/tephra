import { useMemo } from 'react';
import { containServerHtml } from './utils';

/** Server-rendered note HTML with vault-link click handling. */
export function RenderedArticle({
  html,
  onOpen,
  getPathForFileId,
  onUnresolved,
}: {
  html: string;
  onOpen: (path: string) => void;
  getPathForFileId: ((fileId: string) => string | undefined) | undefined;
  onUnresolved: (target: string) => void;
}) {
  const containedHtml = useMemo(() => containServerHtml(html), [html]);
  return (
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
          onUnresolved(unresolvedTarget);
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
          else onUnresolved(targetId);
        } else if (link.getAttribute('href') === '#') {
          // Internal vault link the renderer could not resolve to a file
          // (e.g. ambiguous). Swallow the jump-to-top instead of navigating.
          event.preventDefault();
        }
      }}
      dangerouslySetInnerHTML={{ __html: containedHtml }}
    />
  );
}
