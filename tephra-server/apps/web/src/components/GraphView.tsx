import { useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import type { ForceGraphMethods } from 'react-force-graph-2d';
import { api } from '../api/client';
import type { GraphResponse } from '../api/types';
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

const ACCENT_NODE = '#bd4b31';
const DIM_NODE = '#96a29a';

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
          backgroundColor="#f8f8f4"
          enableZoomInteraction
          enablePanInteraction
          enableNodeDrag
          cooldownTicks={100}
          warmupTicks={25}
          nodeRelSize={4}
          nodeVal={(node) => (activeId !== null && isActive(String(node.id)) ? 2 : 1)}
          nodeColor={(node) => (isActive(String(node.id)) ? ACCENT_NODE : DIM_NODE)}
          linkColor={(link) =>
            activeId === null ||
            link.source === activeId ||
            (typeof link.source === 'object' && link.source?.id === activeId) ||
            link.target === activeId ||
            (typeof link.target === 'object' && link.target?.id === activeId)
              ? 'rgba(189, 75, 49, 0.55)'
              : 'rgba(150, 162, 154, 0.3)'
          }
          linkWidth={(link) => (Number(link.count) > 1 ? 2 : 1)}
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
