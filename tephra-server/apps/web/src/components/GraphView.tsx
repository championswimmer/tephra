import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import type { GraphResponse } from '../api/types';
import { applyFilters } from '../graph/filter';
import { buildGraphModel, nodeRadius } from '../graph/model';
import { resolveGroupColors } from '../graph/renderer/groups';
import { readGraphPalette } from '../graph/renderer/palette';
// The Pixi renderer (~450 KB) stays out of the initial bundle: only its
// type is imported statically, the module itself loads dynamically below.
import type { GraphRenderer } from '../graph/renderer/renderer';
import { createSimulationHost, type SimulationHost } from '../graph/worker/host';
import { loadGraphSettings } from '../graph/settings';
import { useTheme } from '../theme/ThemeContext';
import { EmptyState, ErrorState, IndexPending, Loading } from './Status';

function isNavigable(kind: string): boolean {
  return kind === 'note' || kind === 'attachment';
}

export function GraphView({
  vaultId,
  onOpen,
  selectedId,
}: {
  vaultId: string;
  /** Navigate by vault-relative path (graph nodes carry both id and path). */
  onOpen: (path: string) => void;
  selectedId?: string;
}) {
  const [graph, setGraph] = useState<GraphResponse | null>(null);
  const [error, setError] = useState<unknown>();
  const [reloadToken, setReloadToken] = useState(0);
  const [engineReady, setEngineReady] = useState(false);
  const [webglFailed, setWebglFailed] = useState(false);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const { theme } = useTheme();

  const hostRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<GraphRenderer | null>(null);
  const rendererPromiseRef = useRef<Promise<void> | null>(null);
  const simRef = useRef<SimulationHost | null>(null);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  const modelRef = useRef<ReturnType<typeof buildGraphModel> | null>(null);
  const positionsRef = useRef<Float32Array>(new Float32Array(0));
  const pushedBaseRef = useRef<ReturnType<typeof buildGraphModel> | null>(null);
  const fittedRef = useRef(false);

  // Persisted settings back the filters even before the settings panel
  // (phase 5) makes them editable; Obsidian defaults hide tags/attachments.
  const settings = useMemo(() => loadGraphSettings(vaultId, 'global'), [vaultId]);
  const baseModel = useMemo(() => (graph ? buildGraphModel(graph) : null), [graph]);
  const filtered = useMemo(
    () => (baseModel ? applyFilters(baseModel, settings) : null),
    [baseModel, settings],
  );
  const groupColors = useMemo(
    () => (filtered ? resolveGroupColors(filtered.model, settings.groups) : []),
    [filtered, settings.groups],
  );
  const forces = useMemo(
    () => ({
      centerForce: settings.centerForce,
      repelForce: settings.repelForce,
      linkForce: settings.linkForce,
      linkDistance: settings.linkDistance,
    }),
    [settings.centerForce, settings.repelForce, settings.linkForce, settings.linkDistance],
  );
  const display = useMemo(
    () => ({
      showArrows: settings.showArrows,
      textFadeThreshold: settings.textFadeThreshold,
      nodeSize: settings.nodeSize,
      linkThickness: settings.linkThickness,
    }),
    [settings.showArrows, settings.textFadeThreshold, settings.nodeSize, settings.linkThickness],
  );
  modelRef.current = filtered?.model ?? null;

  useEffect(() => {
    let cancelled = false;
    fittedRef.current = false;
    pushedBaseRef.current = null;
    setGraph(null);
    setError(undefined);
    setHoveredId(null);
    void api.graph(vaultId).then(
      (result) => {
        if (!cancelled) setGraph(result);
      },
      (caught) => {
        if (!cancelled) setError(caught);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [vaultId, reloadToken]);

  // Engine lifecycle: the simulation host (worker with main-thread
  // fallback) is created on mount; the lazily-loaded Pixi renderer is
  // created once the canvas host div mounts (it renders only after the
  // payload arrives).
  useEffect(() => {
    const sim = createSimulationHost({
      onPositions: (positions) => {
        // Copy: the worker recycles the transferred buffer after this call.
        const copy = Float32Array.from(positions);
        positionsRef.current = copy;
        rendererRef.current?.setPositions(copy);
        if (!fittedRef.current && copy.length >= 2) {
          fittedRef.current = true;
          rendererRef.current?.zoomToFit();
        }
      },
    });
    simRef.current = sim;
    return () => {
      sim.destroy();
      simRef.current = null;
      rendererRef.current?.destroy();
      rendererRef.current = null;
      rendererPromiseRef.current = null;
    };
  }, []);

  // Create the renderer on demand; concurrent callers share the flight.
  const ensureRendererRef = useRef<() => Promise<void>>(() => Promise.resolve());
  ensureRendererRef.current = () => {
    if (rendererRef.current || rendererPromiseRef.current) return rendererPromiseRef.current ?? Promise.resolve();
    const sim = simRef.current;
    const host = hostRef.current;
    if (!sim || !host) return Promise.resolve();
    rendererPromiseRef.current = import('../graph/renderer/renderer').then((loaded) =>
      loaded
        .createGraphRenderer(host, {
          onNodeClick: (id) => {
            const node = modelRef.current?.nodes.find((entry) => entry.id === id);
            if (node && isNavigable(node.kind)) onOpenRef.current(node.path);
          },
          onNodeHover: (id) => setHoveredId(id),
          onDragStart: (index) => {
            const positions = positionsRef.current;
            sim.pin(index, positions[index * 2] ?? 0, positions[index * 2 + 1] ?? 0);
          },
          onDragMove: (index, x, y) => sim.pin(index, x, y),
          onDragEnd: (index) => sim.unpin(index),
        })
        .then(
          (created) => {
            rendererRef.current = created;
            created.setTheme(readGraphPalette());
            setEngineReady(true);
          },
          () => {
            // Pixi v8 has no canvas fallback: fall through to the
            // accessible note list with an explanation (§11).
            setWebglFailed(true);
          },
        ),
    );
    return rendererPromiseRef.current;
  };
  const hostCallbackRef = useRef<(element: HTMLDivElement | null) => void>(() => {});
  hostCallbackRef.current = (element) => {
    hostRef.current = element;
    if (element) void ensureRendererRef.current();
  };

  // Push model + settings into the engine whenever they change. A new payload
  // restarts the layout; filter-only changes carry positions across.
  useEffect(() => {
    const renderer = rendererRef.current;
    const sim = simRef.current;
    if (!engineReady || !renderer || !sim || !filtered || !baseModel) return;
    const nodes = filtered.model.nodes;
    const radii = new Float64Array(nodes.length);
    for (let index = 0; index < nodes.length; index += 1)
      radii[index] = nodeRadius(nodes[index]!.degree, settings.nodeSize);
    const topology = {
      nodeCount: nodes.length,
      links: filtered.model.links.map((link) => ({ source: link.source, target: link.target })),
      radii,
    };
    renderer.setModel(filtered.model, groupColors);
    renderer.setSettings(display);
    if (pushedBaseRef.current !== baseModel) {
      pushedBaseRef.current = baseModel;
      fittedRef.current = false;
      sim.setGraph({ ...topology, seed: graph?.revision ?? 1 }, forces);
    } else {
      sim.setFilteredGraph(topology, forces, filtered.indexMap, positionsRef.current);
    }
  }, [engineReady, filtered, baseModel, groupColors, display, forces, graph?.revision, settings.nodeSize]);

  // Re-tint on theme switch; no re-init.
  useEffect(() => {
    rendererRef.current?.setTheme(readGraphPalette());
  }, [theme]);

  useEffect(() => {
    if (engineReady) rendererRef.current?.setActive(selectedId ?? null);
  }, [engineReady, selectedId]);

  // Dev-only debug hook for the Playwright pass (§10).
  useEffect(() => {
    if (import.meta.env.DEV && filtered && graph) {
      (window as unknown as { __tephraGraph?: unknown }).__tephraGraph = {
        nodeCount: filtered.model.nodes.length,
        linkCount: filtered.model.links.length,
        revision: graph.revision,
      };
    }
  }, [filtered, graph]);

  if (error) return <ErrorState error={error} retry={() => setReloadToken((token) => token + 1)} />;
  if (!graph || !baseModel)
    return <Loading label="Loading graph…" />;
  if (baseModel.nodes.length === 0)
    return (
      <EmptyState title="The graph is empty">
        <p>Notes and resolved links appear after the vault is indexed.</p>
      </EmptyState>
    );

  const visible = filtered?.model;
  const activeNode =
    (hoveredId ?? selectedId) ? visible?.nodes.find((node) => node.id === (hoveredId ?? selectedId)) : undefined;
  const activeNavigable = activeNode && isNavigable(activeNode.kind) ? activeNode : undefined;

  return (
    <section className="graph-view" aria-label="Vault graph">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Knowledge map</p>
          <h2>Graph</h2>
        </div>
        <p>
          {visible?.nodes.length ?? 0} notes · {visible?.links.length ?? 0} connections
        </p>
      </div>
      {graph.indexPending && <IndexPending />}
      {webglFailed ? (
        <p className="notice" role="status">
          The interactive graph needs WebGL, which this browser could not provide. The full note
          list below offers the same notes as buttons.
        </p>
      ) : (
        <div
          ref={(element) => hostCallbackRef.current(element)}
          className="graph-canvas"
          role="img"
          aria-label={`Interactive note relationship graph with ${visible?.nodes.length ?? 0} notes and ${visible?.links.length ?? 0} connections. The note list below offers the same notes as buttons.`}
        />
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
      <ul className="graph-fallback-list" aria-label="Notes in graph">
        {graph.nodes
          .filter((node) => node.kind === 'note')
          .map((node) => (
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
      </ul>
    </section>
  );
}
