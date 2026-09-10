import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import type { GraphResponse } from '../api/types';
import { applyFilters } from '../graph/filter';
import { nodesWithinDepth, subgraph } from '../graph/depth';
import { buildGraphModel, nodeRadius } from '../graph/model';
import { resolveGroupColors } from '../graph/renderer/groups';
import { readGraphPalette } from '../graph/renderer/palette';
// The Pixi renderer (~450 KB) stays out of the initial bundle: only its
// type is imported statically, the module itself loads dynamically below.
import type { GraphRenderer, RendererCallbacks } from '../graph/renderer/renderer';
import { createSimulationHost, type SimulationHost } from '../graph/worker/host';
import {
  loadGraphSettings,
  restoreDefaultGraphSettings,
  saveGraphSettings,
  type GraphScope,
} from '../graph/settings';
import { useTheme } from '../theme/ThemeContext';
import { EmptyState, ErrorState, IndexPending, Loading } from './Status';
import { GraphSettingsPanel } from './GraphSettingsPanel';

function isNavigable(kind: string): boolean {
  return kind === 'note' || kind === 'attachment';
}

/** Wall-clock duration of one full time-lapse sweep. */
export const TIME_LAPSE_DURATION_MS = 8000;

// The Pixi renderer (~450 KB) stays out of the initial bundle: only its
// type is imported statically. The module itself loads on demand through
// this shared promise, so concurrently mounting GraphView instances
// (global + local) trigger exactly one fetch instead of racing the module
// registry with duplicate first imports.
type RendererModule = {
  createGraphRenderer: (host: HTMLElement, callbacks: RendererCallbacks) => Promise<GraphRenderer>;
};
let rendererModulePromise: Promise<RendererModule> | null = null;
function loadRendererModule(): Promise<RendererModule> {
  rendererModulePromise ??= import('../graph/renderer/renderer').catch((error: unknown) => {
    rendererModulePromise = null;
    throw error;
  });
  return rendererModulePromise;
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
  const [engineReady, setEngineReady] = useState(false);
  const [webglFailed, setWebglFailed] = useState(false);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const { theme } = useTheme();
  const cogRef = useRef<HTMLButtonElement | null>(null);

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

  // Settings are live state backed by localStorage (keyed per vault and
  // scope, so the global and local graphs never share); every change
  // re-filters the model and re-pushes the engine below. Obsidian defaults
  // hide tags/attachments.
  const [settings, setSettings] = useState(() => loadGraphSettings(vaultId, scope));
  useEffect(() => {
    setSettings(loadGraphSettings(vaultId, scope));
    setPanelOpen(false);
    setCutoffState(null);
    setPlaying(false);
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
  // Time-lapse (§9): animate a createdAt cutoff over the scoped model on
  // wall-clock time. The simulation lives in a worker, so transport and
  // filter controls stay responsive mid-flight. Pausing, scrubbing, or
  // unmounting keeps the last cutoff — playback never snaps back.
  const timeBounds = useMemo(() => {
    if (!scopedBase || scopedBase.nodes.length === 0) return null;
    let min = Infinity;
    let max = -Infinity;
    for (const node of scopedBase.nodes) {
      if (node.createdAt < min) min = node.createdAt;
      if (node.createdAt > max) max = node.createdAt;
    }
    return min < max ? { min, max } : null;
  }, [scopedBase]);
  const [cutoff, setCutoffState] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const playFromRef = useRef(0);
  const playingRef = useRef(playing);
  playingRef.current = playing;

  // Clamp a stale cutoff when the underlying model changes.
  useEffect(() => {
    if (cutoff === null || !timeBounds) return;
    if (cutoff < timeBounds.min) setCutoffState(timeBounds.min);
    else if (cutoff > timeBounds.max) setCutoffState(timeBounds.max);
  }, [cutoff, timeBounds]);

  useEffect(() => {
    if (!playing || !timeBounds) return;
    const from = playFromRef.current;
    const startedAt = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - startedAt) / TIME_LAPSE_DURATION_MS);
      setCutoffState(from + (timeBounds.max - from) * t);
      if (t < 1 && playingRef.current) frame = requestAnimationFrame(step);
      else setPlaying(false);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [playing, timeBounds]);

  const startPlayback = () => {
    if (!timeBounds) return;
    playFromRef.current = cutoff ?? timeBounds.min;
    setPlaying(true);
  };

  const filtered = useMemo(
    () =>
      scopedBase
        ? applyFilters(scopedBase, settings, cutoff === null ? undefined : { createdAtCutoff: cutoff })
        : null,
    [scopedBase, settings, cutoff],
  );
  // Denominator for the time-lapse status: everything the filters keep
  // before the cutoff is applied.
  const uncutCount = useMemo(
    () => (scopedBase ? applyFilters(scopedBase, settings).model.nodes.length : 0),
    [scopedBase, settings],
  );
  // Time-lapse lives here (after scopedBase, before filtered) because the
  // filter memo reads the cutoff during render.
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
    rendererPromiseRef.current = loadRendererModule().then((loaded) =>
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
  // or a new local scope restarts the layout; filter-only changes carry
  // positions across.
  useEffect(() => {
    const renderer = rendererRef.current;
    const sim = simRef.current;
    if (!engineReady || !renderer || !sim || !filtered || !scopedBase) return;
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
    if (pushedBaseRef.current !== scopedBase) {
      pushedBaseRef.current = scopedBase;
      fittedRef.current = false;
      sim.setGraph({ ...topology, seed: graph?.revision ?? 1 }, forces);
    } else {
      sim.setFilteredGraph(topology, forces, filtered.indexMap, positionsRef.current);
    }
  }, [engineReady, filtered, scopedBase, groupColors, display, forces, graph?.revision, settings.nodeSize]);

  // Re-tint on theme switch; no re-init.
  useEffect(() => {
    rendererRef.current?.setTheme(readGraphPalette());
  }, [theme]);

  useEffect(() => {
    if (engineReady) rendererRef.current?.setActive(selectedId ?? null);
  }, [engineReady, selectedId]);

  // Debug hook for the Playwright graph pass (§10): live in dev, and in
  // any build when `?e2eGraph=1` is present. Read-only counts only.
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
    (hoveredId ?? selectedId) ? visible?.nodes.find((node) => node.id === (hoveredId ?? selectedId)) : undefined;
  const activeNavigable = activeNode && isNavigable(activeNode.kind) ? activeNode : undefined;

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
          ref={cogRef}
          type="button"
          aria-expanded={panelOpen}
          aria-controls={`graph-settings-panel-${scope}`}
          aria-label="Graph settings"
          onClick={() => setPanelOpen((open) => !open)}
        >
          ⚙
        </button>
      </div>
      {graph.indexPending && <IndexPending />}
      <div hidden={!panelOpen} onKeyDown={(event) => {
        if (event.key === 'Escape') {
          setPanelOpen(false);
          cogRef.current?.focus();
        }
      }}>
        <GraphSettingsPanel
          id={`graph-settings-panel-${scope}`}
          scope={scope}
          settings={settings}
          onChange={handleSettingsChange}
          onRestoreDefaults={handleRestoreDefaults}
          depthVisible={rootId !== undefined}
        />
      </div>
      {timeBounds && (
        <div className="graph-timelapse" role="group" aria-label="Time-lapse controls">
          <button
            type="button"
            aria-pressed={playing}
            aria-label={playing ? 'Pause time-lapse' : 'Play time-lapse'}
            disabled={!timeBounds}
            onClick={() => (playing ? setPlaying(false) : startPlayback())}
          >
            {playing ? '⏸' : '▶'}
          </button>
          <label htmlFor={`graph-timelapse-${scope}`}>Time-lapse</label>
          <input
            id={`graph-timelapse-${scope}`}
            type="range"
            min={timeBounds.min}
            max={timeBounds.max}
            step={(timeBounds.max - timeBounds.min) / 200 || 1}
            value={cutoff ?? timeBounds.max}
            onChange={(event) => {
              setPlaying(false);
              setCutoffState(Number(event.target.value));
            }}
          />
          <output>{cutoff === null ? `All ${uncutCount} notes` : `${visible?.nodes.length ?? 0} of ${uncutCount} notes up to ${new Date(cutoff).toLocaleDateString()}`}</output>
          {cutoff !== null && (
            <button
              type="button"
              onClick={() => {
                setPlaying(false);
                setCutoffState(null);
              }}
            >
              Reset
            </button>
          )}
        </div>
      )}
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
