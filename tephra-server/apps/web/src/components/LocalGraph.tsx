import { GraphView } from './GraphView';

/**
 * Local graph (§9): the neighbourhood of one open note, reusing GraphView
 * with a root id. Settings persist under the separate `'local'` scope
 * (including the depth slider), so the two instances never share state.
 */
export function LocalGraph({
  vaultId,
  fileId,
  onOpen,
}: {
  vaultId: string;
  /** File id of the open note — the neighbourhood root. */
  fileId: string;
  onOpen: (path: string) => void;
}) {
  return (
    <section className="local-graph" aria-label="Local graph panel">
      <GraphView
        vaultId={vaultId}
        onOpen={onOpen}
        rootId={fileId}
        scope="local"
        selectedId={fileId}
      />
    </section>
  );
}
