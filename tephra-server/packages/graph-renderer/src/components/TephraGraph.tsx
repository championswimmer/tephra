import { useEffect, useState } from 'react';
import {
  ControlsContainer,
  SigmaContainer,
  ZoomControl,
  useLoadGraph,
  useRegisterEvents,
  useSetSettings,
  useSigma,
} from '@react-sigma/core';
import { useWorkerLayoutForceAtlas2 } from '@react-sigma/layout-forceatlas2';
import type { GraphModel } from '../model';
import { buildGraphologyGraph } from '../graphology';
import { forcesToFA2Settings } from '../layout';
import type { GraphPalette } from '../palette';
import type { GraphSettings } from '../settings';

export interface TephraGraphCallbacks {
  /** A node was clicked (navigability is decided by the consumer). */
  onNodeClick: (id: string) => void;
  onNodeHover: (id: string | null) => void;
}

export interface TephraGraphProps extends TephraGraphCallbacks {
  /** Filtered model to render (indices are local to this model). */
  model: GraphModel;
  settings: GraphSettings;
  groupColors: ReadonlyArray<string | null>;
  palette: GraphPalette;
  /** Currently open/selected node id (focused tint + label). */
  selectedId?: string | null;
  /** Seed for deterministic initial positions (e.g. the graph revision). */
  seed?: number;
  /** Live counts for the e2e/debug hook. */
  onReady?: (counts: { nodeCount: number; linkCount: number }) => void;
  onWebglError?: (error: unknown) => void;
}

const DIMMED = '#E2E2E2';
/** Label opacity ramp mirroring the old text-fade-threshold behaviour. */
const LABEL_SIZE_THRESHOLD = 6;

/** Keyboard camera: arrows pan, +/- zoom, Shift accelerates (Obsidian parity). */
function KeyboardCamera() {
  const sigma = useSigma();
  useEffect(() => {
    const container = sigma.getContainer();
    container.tabIndex = 0;
    const onKey = (event: KeyboardEvent) => {
      const step = event.shiftKey ? 120 : 40;
      const camera = sigma.getCamera();
      const state = camera.getState();
      switch (event.key) {
        case '+':
        case '=':
          void camera.animate({ ...state, ratio: state.ratio / 1.2 });
          break;
        case '-':
        case '_':
          void camera.animate({ ...state, ratio: state.ratio * 1.2 });
          break;
        case 'ArrowLeft':
          void camera.animate({ ...state, x: state.x - step * state.ratio });
          break;
        case 'ArrowRight':
          void camera.animate({ ...state, x: state.x + step * state.ratio });
          break;
        case 'ArrowUp':
          void camera.animate({ ...state, y: state.y - step * state.ratio });
          break;
        case 'ArrowDown':
          void camera.animate({ ...state, y: state.y + step * state.ratio });
          break;
        default:
          return;
      }
      event.preventDefault();
    };
    container.addEventListener('keydown', onKey);
    return () => container.removeEventListener('keydown', onKey);
  }, [sigma]);
  return null;
}

function LoadGraph({
  model,
  settings,
  groupColors,
  palette,
  seed,
  onReady,
}: {
  model: GraphModel;
  settings: GraphSettings;
  groupColors: ReadonlyArray<string | null>;
  palette: GraphPalette;
  seed: number | undefined;
  onReady?: ((counts: { nodeCount: number; linkCount: number }) => void) | undefined;
}) {
  const loadGraph = useLoadGraph();
  useEffect(() => {
    loadGraph(
      buildGraphologyGraph(model, {
        nodeSize: settings.nodeSize,
        linkThickness: settings.linkThickness,
        groupColors,
        palette,
        seed,
      }),
    );
    onReady?.({ nodeCount: model.nodes.length, linkCount: model.links.length });
  }, [
    loadGraph,
    model,
    settings.nodeSize,
    settings.linkThickness,
    groupColors,
    palette,
    seed,
    onReady,
  ]);
  return null;
}

function Layout({ settings }: { settings: GraphSettings }) {
  const { start, stop, kill } = useWorkerLayoutForceAtlas2({
    settings: forcesToFA2Settings(settings),
  });
  useEffect(() => {
    start();
    // Let the layout settle, then stop so an idle graph costs no CPU.
    const timeout = setTimeout(() => stop(), 4000);
    return () => {
      clearTimeout(timeout);
      kill();
    };
  }, [start, stop, kill]);
  return null;
}

function Effects({ onNodeClick, onNodeHover }: TephraGraphCallbacks) {
  const registerEvents = useRegisterEvents();
  useEffect(() => {
    registerEvents({
      enterNode: (event) => onNodeHover(event.node),
      leaveNode: () => onNodeHover(null),
      clickNode: (event) => onNodeClick(event.node),
    });
  }, [registerEvents, onNodeClick, onNodeHover]);
  return null;
}

function Reducers({
  model,
  selectedId,
  hoveredId,
  showArrows,
  textFadeThreshold,
}: {
  model: GraphModel;
  selectedId: string | null;
  hoveredId: string | null;
  showArrows: boolean;
  textFadeThreshold: number;
}) {
  const sigma = useSigma();
  const setSettings = useSetSettings();
  useEffect(() => {
    const active = hoveredId ?? selectedId;
    const neighbours = new Set<string>();
    if (active) {
      const index = model.indexById.get(active);
      if (index !== undefined)
        for (const neighbour of model.adjacency[index]!) neighbours.add(model.nodes[neighbour]!.id);
      neighbours.add(active);
    }
    setSettings({
      defaultEdgeType: showArrows ? 'arrow' : 'line',
      labelRenderedSizeThreshold:
        textFadeThreshold <= 0 ? Number.POSITIVE_INFINITY : LABEL_SIZE_THRESHOLD,
      nodeReducer: (node, data) => {
        if (!active) return data;
        if (node === active) return { ...data, highlighted: true, zIndex: 1 };
        if (neighbours.has(node)) return { ...data, highlighted: true };
        return { ...data, color: DIMMED };
      },
      edgeReducer: (edge, data) => {
        if (!active) return data;
        const graph = sigma.getGraph();
        try {
          if (graph.extremities(edge).includes(active)) return data;
        } catch {
          return data;
        }
        return { ...data, hidden: true };
      },
    });
  }, [sigma, setSettings, model, selectedId, hoveredId, showArrows, textFadeThreshold]);
  return null;
}

/**
 * Embeddable Obsidian-style vault graph on Sigma WebGL.
 *
 * The consumer owns fetching/filtering/settings persistence and passes the
 * filtered model in; this component owns layout + rendering + interaction.
 * Consumers must import `@react-sigma/core/lib/style.css` once in their app
 * (library CSS is left to the app bundler on purpose).
 */
export function TephraGraph({
  model,
  settings,
  groupColors,
  palette,
  selectedId = null,
  seed = 1,
  onNodeClick,
  onNodeHover,
  onReady,
  onWebglError,
}: TephraGraphProps) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [failed, setFailed] = useState<unknown>(null);

  useEffect(() => {
    if (failed !== null && failed !== undefined) onWebglError?.(failed);
  }, [failed, onWebglError]);

  if (failed) return null;

  const handleHover = (id: string | null) => {
    setHoveredId(id);
    onNodeHover(id);
  };

  return (
    <SigmaContainer
      className="tephra-graph"
      style={{ height: '100%', width: '100%', background: 'transparent' }}
      settings={{
        allowInvalidContainer: true,
        renderEdgeLabels: false,
        hideLabelsOnMove: false,
        labelDensity: 0.2,
      }}
    >
      <WebglGuard onError={setFailed} />
      <LoadGraph
        model={model}
        settings={settings}
        groupColors={groupColors}
        palette={palette}
        seed={seed}
        onReady={onReady}
      />
      <Layout settings={settings} />
      <Effects onNodeClick={onNodeClick} onNodeHover={handleHover} />
      <Reducers
        model={model}
        selectedId={selectedId ?? null}
        hoveredId={hoveredId}
        showArrows={settings.showArrows}
        textFadeThreshold={settings.textFadeThreshold}
      />
      <KeyboardCamera />
      <ControlsContainer position="bottom-right">
        <ZoomControl />
      </ControlsContainer>
    </SigmaContainer>
  );
}

/** Catches Sigma's WebGL/context failure and reports it instead of crashing React. */
function WebglGuard({ onError }: { onError: (error: unknown) => void }) {
  const sigma = useSigma();
  useEffect(() => {
    try {
      sigma.getContainer();
      sigma.refresh();
    } catch (error) {
      onError(error);
    }
  }, [sigma, onError]);
  return null;
}
