import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import type { GraphResponse } from '../api/types';
import { EmptyState, ErrorState, IndexPending, Loading } from './Status';

export function GraphView({ vaultId, onOpen }: { vaultId: string; onOpen: (id: string) => void }) {
  const [graph, setGraph] = useState<GraphResponse | null>(null);
  const [error, setError] = useState<unknown>();
  const [selected, setSelected] = useState<string>();
  async function load() {
    setError(undefined);
    try {
      setGraph(await api.graph(vaultId));
    } catch (caught) {
      setError(caught);
    }
  }
  useEffect(() => {
    void load();
  }, [vaultId]);
  const layout = useMemo(() => {
    if (!graph) return new Map<string, { x: number; y: number }>();
    const map = new Map<string, { x: number; y: number }>();
    graph.nodes.forEach((node, index) => {
      const angle = (index / Math.max(graph.nodes.length, 1)) * Math.PI * 2;
      const ring = 34 + (index % 3) * 8;
      map.set(node.id, { x: 50 + Math.cos(angle) * ring, y: 50 + Math.sin(angle) * ring });
    });
    return map;
  }, [graph]);
  if (error) return <ErrorState error={error} retry={() => void load()} />;
  if (!graph) return <Loading label="Loading graph…" />;
  if (!graph.nodes.length)
    return (
      <EmptyState title="The graph is empty">
        <p>Notes and resolved links appear after the vault is indexed.</p>
      </EmptyState>
    );
  const neighbors = new Set(
    graph.edges.flatMap((edge) =>
      edge.source === selected ? [edge.target] : edge.target === selected ? [edge.source] : [],
    ),
  );
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
      <svg viewBox="0 0 100 100" role="img" aria-label="Interactive note relationship graph">
        {graph.edges.map((edge, i) => {
          const a = layout.get(edge.source),
            b = layout.get(edge.target);
          if (!a || !b) return null;
          const active = !selected || edge.source === selected || edge.target === selected;
          return (
            <line
              key={`${edge.source}-${edge.target}-${i}`}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              className={active ? 'graph-edge active' : 'graph-edge'}
            />
          );
        })}
        {graph.nodes.map((node) => {
          const point = layout.get(node.id)!;
          const active = !selected || selected === node.id || neighbors.has(node.id);
          return (
            <g
              key={node.id}
              className={active ? 'graph-node active' : 'graph-node'}
              transform={`translate(${point.x} ${point.y})`}
              onMouseEnter={() => setSelected(node.id)}
              onFocus={() => setSelected(node.id)}
              onClick={() => onOpen(node.id)}
              role="button"
              tabIndex={0}
              aria-label={`Open ${node.title ?? node.path}`}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') onOpen(node.id);
              }}
            >
              <circle r={selected === node.id ? 3 : 2} />
              <title>{node.title ?? node.path}</title>
            </g>
          );
        })}
      </svg>
      {selected && (
        <div className="graph-selection">
          <span>
            {graph.nodes.find((node) => node.id === selected)?.title ??
              graph.nodes.find((node) => node.id === selected)?.path}
          </span>
          <button type="button" onClick={() => onOpen(selected)}>
            Open note
          </button>
        </div>
      )}
    </section>
  );
}
