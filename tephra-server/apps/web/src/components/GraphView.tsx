import { useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import type { ForceGraphMethods } from 'react-force-graph-2d';
import { api } from '../api/client';
import type { GraphResponse } from '../api/types';
import { useTheme } from '../theme/ThemeContext';
import { EmptyState, ErrorState, IndexPending, Loading } from './Status';

export interface GraphNodeDatum {
  id: string;
  label: string;
  path: string;
}

export interface GraphLinkDatum {
  source: string;
  target: string;
  count: number;
}

export interface ForceGraphDatum {
  nodes: GraphNodeDatum[];
  links: GraphLinkDatum[];
}

/** Map `/graph` API nodes/edges onto the `{ nodes, links }` shape react-force-graph expects. */
export function mapGraphToForceData(graph: GraphResponse): ForceGraphDatum {
  return {
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      label: node.title ?? node.path,
      path: node.path,
    })),
    links: graph.edges.map((edge) => ({
      source: edge.source,
      target: edge.target,
      count: edge.count,
    })),
  };
}

/** Expand `#rgb` / `#rrggbb` to an `rgba()` string for dimmed graph states. */
export function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace(/^#/, '');
  const full =
    clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const value = Number.parseInt(full.slice(0, 6).padEnd(6, '0'), 16);
  const red = (value >> 16) & 0xff;
  const green = (value >> 8) & 0xff;
  const blue = value & 0xff;
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

export function GraphView({
  vaultId,
  onOpen,
  selectedId,
}: {
  vaultId: string;
  onOpen: (id: string) => void;
  selectedId?: string;
}) {
  const [graph, setGraph] = useState<GraphResponse | null>(null);
  const [error, setError] = useState<unknown>();
  const [hovered, setHovered] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const graphRef = useRef<ForceGraphMethods | undefined>(undefined);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 640, height: 480 });
  const fittedRef = useRef(false);
  // Obsidian-palette colors for the active base scheme. The provider
  // re-renders this view on theme switch, so the canvas follows light/dark.
  const { theme } = useTheme();
  const palette = {
    background: theme.variables['--background-primary'] ?? '#ffffff',
    node: theme.variables['--graph-node'] ?? '#000000',
    line: theme.variables['--graph-line'] ?? '#d1d1d1',
    accent: theme.variables['--interactive-accent'] ?? '#7b6cd9',
    text: theme.variables['--text-normal'] ?? '#2e3338',
    muted: theme.variables['--text-muted'] ?? '#71747b',
  };

  useEffect(() => {
    let cancelled = false;
    fittedRef.current = false;
    setGraph(null);
    setError(undefined);
    setHovered(null);
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

  // Size the canvas to its container (the library defaults to window
  // dimensions, which would overflow the card and break zoom-to-fit). Keep a
  // fixed height that matches the `.graph-canvas` stylesheet rule.
  useEffect(() => {
    const element = containerRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const update = () => {
      const height = Math.min(window.innerHeight * 0.62, 620);
      setCanvasSize({ width: Math.max(1, element.clientWidth), height });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [graph]);

  // Stop the force simulation if the view unmounts mid-flight.
  useEffect(
    () => () => {
      try {
        graphRef.current?.pauseAnimation();
      } catch {
        /* graph already torn down */
      }
    },
    [],
  );

  const data = useMemo<ForceGraphDatum>(
    () => (graph ? mapGraphToForceData(graph) : { nodes: [], links: [] }),
    [graph],
  );
  const labels = useMemo(() => {
    const map = new Map<string, string>();
    for (const node of data.nodes) map.set(node.id, node.label);
    return map;
  }, [data]);

  // The currently-open note (when provided) and the hovered node stay
  // highlighted along with their neighbours; everything else is dimmed,
  // mirroring the old SVG view's active/inactive styling.
  const activeId = hovered ?? selectedId ?? null;
  const neighbors = useMemo(() => {
    if (!graph || !activeId) return new Set<string>();
    return new Set(
      graph.edges.flatMap((edge) =>
        edge.source === activeId
          ? [edge.target]
          : edge.target === activeId
            ? [edge.source]
            : [],
      ),
    );
  }, [graph, activeId]);
  const isActive = (id: string) =>
    activeId === null || id === activeId || neighbors.has(id);

  if (error)
    return <ErrorState error={error} retry={() => setReloadToken((token) => token + 1)} />;
  if (!graph) return <Loading label="Loading graph…" />;
  if (!graph.nodes.length)
    return (
      <EmptyState title="The graph is empty">
        <p>Notes and resolved links appear after the vault is indexed.</p>
      </EmptyState>
    );

  const activeNode = activeId
    ? graph.nodes.find((node) => node.id === activeId)
    : undefined;

  // Obsidian graph language: uniform small dots in the graph-node color,
  // faint graph-line edges with directional arrows, and the hovered/selected
  // node plus its neighbourhood picked out in the accent color. When
  // something is active, unrelated nodes and edges fade back.
  const dimNode = hexToRgba(palette.node, 0.22);
  const dimLine = hexToRgba(palette.line, 0.45);
  const activeLine = hexToRgba(palette.accent, 0.65);
  const paintNodeColor = (id: string): string => {
    if (activeId === null) return palette.node;
    return isActive(id) ? palette.accent : dimNode;
  };
  const paintLinkColor = (sourceId: string, targetId: string): string => {
    if (activeId === null) return palette.line;
    return sourceId === activeId || targetId === activeId ? activeLine : dimLine;
  };
  const linkEndpointId = (endpoint: unknown): string =>
    typeof endpoint === 'object' && endpoint !== null
      ? String((endpoint as { id?: unknown }).id)
      : String(endpoint);

  return (
    <section className="graph-view" aria-label="Vault graph">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Knowledge map</p>
          <h2>Graph</h2>
        </div>
        <p>
          {graph.nodes.length} notes · {graph.edges.length} connections
        </p>
      </div>
      {graph.indexPending && <IndexPending />}
      <div
        ref={containerRef}
        className="graph-canvas"
        role="img"
        aria-label={`Interactive note relationship graph with ${graph.nodes.length} notes and ${graph.edges.length} connections. The note list below offers the same notes as buttons.`}
      >
        <ForceGraph2D
          ref={graphRef}
          width={canvasSize.width}
          height={canvasSize.height}
          graphData={data}
          nodeId="id"
          nodeLabel="label"
          linkSource="source"
          linkTarget="target"
          backgroundColor={palette.background}
          enableZoomInteraction
          enablePanInteraction
          enableNodeDrag
          cooldownTicks={100}
          warmupTicks={25}
          nodeRelSize={4}
          nodeColor={(node) => paintNodeColor(String(node.id))}
          linkColor={(link) =>
            paintLinkColor(linkEndpointId(link.source), linkEndpointId(link.target))
          }
          linkWidth={(link) => (Number(link.count) > 1 ? 2 : 1)}
          linkDirectionalArrowLength={3.5}
          linkDirectionalArrowRelPos={1}
          linkDirectionalArrowColor={(link) =>
            paintLinkColor(linkEndpointId(link.source), linkEndpointId(link.target))
          }
          nodeCanvasObjectMode={() => 'after'}
          nodeCanvasObject={(node, ctx, globalScale) => {
            const id = String(node.id);
            const label = labels.get(id) ?? id;
            const fontSize = 12 / globalScale;
            ctx.font = `${fontSize}px Inter, system-ui, sans-serif`;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillStyle =
              activeId === null || isActive(id) ? palette.text : palette.muted;
            ctx.globalAlpha = activeId !== null && !isActive(id) ? 0.45 : 1;
            ctx.fillText(label, (node.x ?? 0) + 6, (node.y ?? 0));
            ctx.globalAlpha = 1;
          }}
          onNodeClick={(node) => {
            onOpen(String(node.id));
          }}
          onNodeHover={(node) => {
            // After d3 resolves links, source/target become node objects.
            setHovered(node ? String(node.id) : null);
          }}
          onEngineStop={() => {
            if (fittedRef.current || data.nodes.length < 2) return;
            fittedRef.current = true;
            try {
              graphRef.current?.zoomToFit(300, 40);
            } catch {
              /* canvas already unmounted */
            }
          }}
        />
      </div>
      {activeNode && (
        <div className="graph-selection">
          <span>{activeNode.title ?? activeNode.path}</span>
          <button type="button" onClick={() => onOpen(activeNode.id)}>
            Open note
          </button>
        </div>
      )}
      <ul className="graph-fallback-list" aria-label="Notes in graph">
        {graph.nodes.map((node) => (
          <li key={node.id}>
            <button
              type="button"
              onClick={() => onOpen(node.id)}
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
