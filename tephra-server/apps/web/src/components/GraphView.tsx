import { useEffect, useMemo, useRef, useState } from 'react';
import { Play, SlidersHorizontal } from 'lucide-react';
import { TephraGraph } from '@tephra/graph-renderer';
import {
  applyFilters,
  buildGraphModel,
  loadGraphSettings,
  MAX_VISIBLE_NODES,
  nodesWithinDepth,
  readGraphPalette,
  resolveGroupColors,
  restoreDefaultGraphSettings,
  saveGraphSettings,
  subgraph,
  type GraphScope,
} from '@tephra/graph-renderer/pure';
import { api } from '../api/client';
import { loadGraphCache } from '../api/graphCache';
import type { GraphResponse } from '../api/types';
import { useTheme } from '../theme/ThemeContext';
import { EmptyState, ErrorState, IndexPending, Loading } from './Status';
import { GraphSettingsPanel } from './GraphSettingsPanel';

function isNavigable(kind: string): boolean {
  return kind === 'note' || kind === 'attachment';
}

export function GraphView({
  vaultId,
  onOpen,
  selectedId,
  rootId,
  scope = 'global',
}: {
  vaultId: string;
  /** Navigate by vault-relative path (graph nodes carry both id and path). */
  onOpen: (path: string) => void;
  selectedId?: string;
  /**
   * Local-graph mode: restrict the view to the neighbourhood of this node
   * id (a file id) within `settings.depth` hops. Persisted separately under
   * the `'local'` scope.
   */
  rootId?: string;
  scope?: GraphScope;
}) {
  const [graph, setGraph] = useState<GraphResponse | null>(null);
  const [error, setError] = useState<unknown>();
  const [reloadToken, setReloadToken] = useState(0);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const { theme } = useTheme();
  const cogRef = useRef<HTMLButtonElement | null>(null);

  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  // Settings are live state backed by localStorage (keyed per vault and
  // scope, so the global and local graphs never share); every change
  // re-filters the model shown in the canvas below.
  // Obsidian defaults hide tags/attachments.
  const [settings, setSettings] = useState(() => loadGraphSettings(vaultId, scope));
  const [animateToken, setAnimateToken] = useState(0);
  useEffect(() => {
    setSettings(loadGraphSettings(vaultId, scope));
    setPanelOpen(false);
    setHoveredId(null);
    setAnimateToken(0);
  }, [vaultId, scope]);
  const handleSettingsChange = (next: typeof settings) => {
    setSettings(next);
    saveGraphSettings(vaultId, scope, next);
  };
  const handleRestoreDefaults = () => {
    setSettings(restoreDefaultGraphSettings(vaultId, scope));
  };
  const baseModel = useMemo(() => (graph ? buildGraphModel(graph) : null), [graph]);
  // Local-graph mode structurally restricts to the root neighbourhood
  // before filtering, so filters and groups behave exactly as globally.
  const scopedBase = useMemo(() => {
    if (!baseModel) return null;
    if (!rootId) return baseModel;
    const within = nodesWithinDepth(baseModel, rootId, settings.depth);
    if (within.size === 0) return null;
    return subgraph(baseModel, within);
  }, [baseModel, rootId, settings.depth]);
  const filtered = useMemo(
    () => (scopedBase ? applyFilters(scopedBase, settings) : null),
    [scopedBase, settings],
  );
  const groupColors = useMemo(
    () => (filtered ? resolveGroupColors(filtered.model, settings.groups) : []),
    [filtered, settings.groups],
  );
  // Re-tint on theme switch: readGraphPalette() reads the live CSS
  // variables, so depending on `theme` re-tints without re-init.
  const palette = useMemo(() => readGraphPalette(), [theme]);

  // Stale-while-revalidate (plan 016, Lane B): paint the IndexedDB snapshot
  // instantly when present, then revalidate in the background. When the
  // server answers with an unchanged revision the second setGraph is skipped
  // to avoid a redundant buildGraphModel + canvas pass.
  useEffect(() => {
    let cancelled = false;
    setGraph(null);
    setError(undefined);
    setHoveredId(null);
    void (async () => {
      let staleRevision: number | undefined;
      const stale = await loadGraphCache(vaultId);
      if (!cancelled && stale) {
        staleRevision = stale.body.revision;
        setGraph(stale.body);
      }
      try {
        const result = await api.graph(vaultId);
        if (!cancelled && result.revision !== staleRevision) setGraph(result);
      } catch (caught) {
        if (!cancelled) setError(caught);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [vaultId, reloadToken]);

  // Debug hook for the Playwright graph pass: live in dev, and in any
  // build when `?e2eGraph=1` is present. Read-only counts only.
  useEffect(() => {
    const debug =
      import.meta.env.DEV || new URLSearchParams(window.location.search).has('e2eGraph');
    if (debug && filtered && graph) {
      (window as unknown as { __tephraGraph?: unknown }).__tephraGraph = {
        nodeCount: filtered.model.nodes.length,
        linkCount: filtered.model.links.length,
        revision: graph.revision,
      };
    }
  }, [filtered, graph]);

  if (error) return <ErrorState error={error} retry={() => setReloadToken((token) => token + 1)} />;
  if (!graph || !baseModel)
    return <Loading label={rootId ? 'Loading local graph…' : 'Loading graph…'} />;
  if (baseModel.nodes.length === 0)
    return (
      <EmptyState title="The graph is empty">
        <p>Notes and resolved links appear after the vault is indexed.</p>
      </EmptyState>
    );
  if (rootId && (!scopedBase || scopedBase.nodes.length <= 1))
    return (
      <EmptyState title="No local graph yet">
        <p>This note has no linked neighbours within depth {settings.depth}.</p>
        <p>Link it to other notes to grow its neighbourhood.</p>
        <p>
          <button type="button" onClick={() => setReloadToken((token) => token + 1)}>
            Retry
          </button>
        </p>
      </EmptyState>
    );

  const visible = filtered?.model;
  const neighbourCount = rootId && scopedBase ? scopedBase.nodes.length - 1 : null;
  const activeNode =
    (hoveredId ?? selectedId)
      ? visible?.nodes.find((node) => node.id === (hoveredId ?? selectedId))
      : undefined;
  const activeNavigable = activeNode && isNavigable(activeNode.kind) ? activeNode : undefined;

  const handleNodeClick = (id: string) => {
    const node = visible?.nodes.find((entry) => entry.id === id);
    if (node && isNavigable(node.kind)) onOpenRef.current(node.path);
  };
  const handleNodeHover = (id: string | null) => setHoveredId(id);
  const handleReady = () => {
    const debug =
      import.meta.env.DEV || new URLSearchParams(window.location.search).has('e2eGraph');
    if (debug && filtered && graph) {
      (window as unknown as { __tephraGraph?: unknown }).__tephraGraph = {
        nodeCount: filtered.model.nodes.length,
        linkCount: filtered.model.links.length,
        revision: graph.revision,
      };
    }
  };

  return (
    <section className="graph-view" aria-label={rootId ? 'Local graph' : 'Vault graph'}>
      <div className="section-heading">
        <div>
          <p className="eyebrow">{rootId ? 'Neighbourhood' : 'Knowledge map'}</p>
          <h2>{rootId ? 'Local graph' : 'Graph'}</h2>
        </div>
        <p>
          {neighbourCount === null
            ? `${visible?.nodes.length ?? 0} notes · ${visible?.links.length ?? 0} connections`
            : `${neighbourCount} neighbour${neighbourCount === 1 ? '' : 's'} within depth ${settings.depth}`}
        </p>
        <button
          type="button"
          aria-label="Animate graph"
          title="Animate graph"
          onClick={() => setAnimateToken((token) => token + 1)}
        >
          <Play size={16} aria-hidden="true" focusable="false" className="icon" />
        </button>
        <button
          ref={cogRef}
          type="button"
          aria-expanded={panelOpen}
          aria-controls={`graph-settings-panel-${scope}`}
          aria-label="Graph settings"
          onClick={() => setPanelOpen((open) => !open)}
        >
          <SlidersHorizontal size={16} aria-hidden="true" focusable="false" className="icon" />
        </button>
      </div>
      {graph.indexPending && <IndexPending />}
      <div
        hidden={!panelOpen}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            setPanelOpen(false);
            cogRef.current?.focus();
          }
        }}
      >
        <GraphSettingsPanel
          id={`graph-settings-panel-${scope}`}
          scope={scope}
          settings={settings}
          onChange={handleSettingsChange}
          onRestoreDefaults={handleRestoreDefaults}
          depthVisible={rootId !== undefined}
        />
      </div>
      {filtered && (
        <div
          className="graph-canvas"
          role="img"
          aria-label={`Interactive note relationship graph with ${visible?.nodes.length ?? 0} notes and ${visible?.links.length ?? 0} connections. The note list below offers the same notes as buttons.`}
          data-testid="graph-canvas"
        >
          <TephraGraph
            model={filtered.model}
            settings={settings}
            groupColors={groupColors}
            palette={palette}
            selectedId={selectedId ?? null}
            seed={graph.revision}
            animateToken={animateToken}
            onNodeClick={handleNodeClick}
            onNodeHover={handleNodeHover}
            onReady={handleReady}
          />
        </div>
      )}
      {activeNode && (
        <div className="graph-selection">
          <span>{activeNode.title ?? activeNode.path}</span>
          {activeNavigable && (
            <button type="button" onClick={() => onOpen(activeNavigable.path)}>
              Open note
            </button>
          )}
        </div>
      )}
      {graph.truncated && (
        <p className="notice" role="status">
          Showing the first {graph.nodes.length} nodes — the vault graph is larger than the 10 000
          node limit.
        </p>
      )}
      {filtered && filtered.model.nodes.length > MAX_VISIBLE_NODES && (
        <p className="notice" role="status" data-testid="graph-budget-notice">
          Showing {MAX_VISIBLE_NODES} of {filtered.model.nodes.length} — zoom in to reveal smaller
          nodes.
        </p>
      )}
      {(() => {
        const FALLBACK_LIST_LIMIT = 200;
        const noteNodes = graph.nodes.filter((node) => node.kind === 'note');
        const shown = noteNodes.slice(0, FALLBACK_LIST_LIMIT);
        const hidden = noteNodes.length - shown.length;
        return (
          <ul className="graph-fallback-list" aria-label="Notes in graph">
            {shown.map((node) => (
              <li key={node.id}>
                <button
                  type="button"
                  onClick={() => onOpen(node.path)}
                  aria-current={node.id === selectedId ? 'true' : undefined}
                >
                  {node.title ?? node.path}
                </button>
              </li>
            ))}
            {hidden > 0 && <li>…and {hidden} more — use search to open a note</li>}
          </ul>
        );
      })()}
    </section>
  );
}
