/**
 * Scene buffers (plan 018): turns the graph model + style inputs + hover /
 * selection state into the typed arrays a {@link DrawBackend} and the
 * {@link LabelLayer} consume.
 *
 * Work is split by how often inputs change:
 * - `setModel` (ids/links changed): allocate per-model arrays, label text,
 *   degree order, edge endpoint arrays.
 * - `setStyle` (palette / group colours / sizes changed): parse CSS colours
 *   once into base RGBA arrays, recompute radii and base edge widths.
 * - `update` (every frame): apply the hover highlight blend, zoom-dependent
 *   edge widths, focus rings, and label opacities — reusing every array and
 *   the single {@link SceneFrame} / {@link LabelFrame} objects, so a
 *   steady-state frame allocates nothing. Passes whose inputs did not
 *   change since the previous frame are skipped.
 */

import type { CameraState, ViewportSize } from '../camera';
import { nodeRadius, type GraphModel, type RenderNode } from '../model';
import type { GraphPalette } from '../palette';
import type { GraphSettings } from '../settings';
import { writeCssColor } from './color';
import { labelFadeOpacity } from './labels';
import type { LabelFrame, SceneFrame } from './types';

/** Hover highlight fade duration (ms) for `highlight` 0 → 1 and back. */
export const HOVER_FADE_MS = 200;
/** Alpha of non-neighbour nodes at full highlight. */
const HOVER_NODE_DIM = 0.2;
/** Alpha multiplier of edges not touching the hovered node at full highlight. */
const HOVER_EDGE_DIM = 0.1;
/** Max labels drawn per frame. */
export const MAX_LABELS = 400;
/** Edge screen width clamp, CSS px. */
const EDGE_WIDTH_MIN = 0.5;
const EDGE_WIDTH_MAX = 8;

const EMPTY_F32 = new Float32Array(0);
const EMPTY_U32 = new Uint32Array(0);
const EMPTY_U8 = new Uint8Array(0);

/** Unclamped world-independent edge width: `linkThickness * (1 + log2(count))`. */
export function edgeBaseWidth(count: number, linkThickness: number): number {
  return linkThickness * (1 + Math.log2(Math.max(1, count)));
}

/** Screen-space edge width in CSS px: `clamp(base * min(1, k), 0.5, 8)`. */
export function edgeScreenWidth(baseWidth: number, k: number): number {
  const w = baseWidth * (k < 1 ? k : 1);
  return w < EDGE_WIDTH_MIN ? EDGE_WIDTH_MIN : w > EDGE_WIDTH_MAX ? EDGE_WIDTH_MAX : w;
}

/** Label text: title, else basename of the path without `.md`, else id. */
export function nodeLabelText(node: Pick<RenderNode, 'id' | 'path' | 'title'>): string {
  if (node.title !== null && node.title.length > 0) return node.title;
  if (node.path.length > 0) {
    const slash = node.path.lastIndexOf('/');
    const base = slash >= 0 ? node.path.slice(slash + 1) : node.path;
    const stripped = base.toLowerCase().endsWith('.md') ? base.slice(0, -3) : base;
    if (stripped.length > 0) return stripped;
  }
  return node.id;
}

function kindColor(kind: string, palette: GraphPalette): string {
  switch (kind) {
    case 'tag':
      return palette.tag;
    case 'attachment':
      return palette.attachment;
    case 'unresolved':
      return palette.unresolved;
    default:
      return palette.node;
  }
}

export interface Scene {
  /** Reused frame object handed to the draw backend every frame. */
  readonly frame: SceneFrame;
  /** Reused label inputs handed to the label layer every frame. */
  readonly labels: LabelFrame;
  /** Current hover highlight in [0, 1]. */
  readonly highlight: number;
  /** Node the highlight is centred on (stays set while fading out), or -1. */
  readonly highlightNode: number;
  /** Current hovered node index, or -1. */
  readonly hovered: number;
  /** Node count of the current model. */
  readonly nodeCount: number;
  /**
   * Rebuild per-model arrays (ids or links changed). Call `setStyle` after.
   * `keepInteraction` keeps hover / selection / highlight indices (only
   * meaningful when the node id list is unchanged).
   */
  setModel(model: GraphModel, keepInteraction?: boolean): void;
  /** Recompute base colours, radii, and base edge widths. */
  setStyle(groupColors: ReadonlyArray<string | null>, palette: GraphPalette, settings: GraphSettings): void;
  /** Point the frame at live world positions (length ≥ nodeCount). */
  setPositions(x: Float32Array, y: Float32Array): void;
  /** Hovered node index or -1. Starts the highlight fade in / out. */
  setHovered(index: number): void;
  /** Selected node index or -1. */
  setSelected(index: number): void;
  /** Advance the highlight fade by `dtMs`. Returns true while still animating. */
  stepHighlight(dtMs: number): boolean;
  /** True while the highlight has not reached its target. */
  isHighlightAnimating(): boolean;
  /** Fill per-frame buffers for this camera / viewport. Allocation-free. */
  update(camera: CameraState, viewport: ViewportSize, dpr: number): void;
}

export function createScene(): Scene {
  const frame: SceneFrame = {
    camera: { x: 0, y: 0, k: 1 },
    viewport: { width: 0, height: 0 },
    dpr: 1,
    nodeCount: 0,
    x: EMPTY_F32,
    y: EMPTY_F32,
    radius: EMPTY_F32,
    nodeRGBA: EMPTY_F32,
    nodeRing: EMPTY_U8,
    ringRGBA: new Float32Array(4),
    edgeCount: 0,
    edgeSource: EMPTY_U32,
    edgeTarget: EMPTY_U32,
    edgeWidth: EMPTY_F32,
    edgeRGBA: EMPTY_F32,
    arrows: false,
  };
  const labels: LabelFrame = {
    text: [],
    opacity: EMPTY_F32,
    order: EMPTY_U32,
    color: '#000000',
    maxLabels: MAX_LABELS,
  };

  let model: GraphModel | null = null;
  let n = 0;
  let m = 0;
  /** Base (un-highlighted) colours. */
  let nodeBase = EMPTY_F32;
  let edgeBase = EMPTY_F32;
  let edgeBaseW = EMPTY_F32;
  const focused = new Float32Array(4);
  /** 1 = hovered or neighbour of `highlightNode` (2 transiently while ordering). */
  let mark = EMPTY_U8;
  /** Node indices sorted by degree desc (ties by index). */
  let degreeOrder = EMPTY_U32;
  let textFadeThreshold = 0;

  let hovered = -1;
  let selected = -1;
  let highlightNode = -1;
  let highlight = 0;

  // Dirty tracking so unchanged passes are skipped.
  let styleVersion = 0;
  let appliedStyle = -1;
  let appliedH = -1;
  let appliedHNode = -2;
  let appliedK = NaN;
  let appliedFadeH = -1;
  let orderNode = -2;
  let orderVersion = -1;
  let modelVersion = 0;

  function setModel(next: GraphModel, keepInteraction = false): void {
    const keep = keepInteraction && next.nodes.length === n;
    model = next;
    modelVersion += 1;
    n = next.nodes.length;
    m = next.links.length;
    frame.nodeCount = n;
    frame.edgeCount = m;
    if (frame.radius.length !== n) {
      frame.radius = new Float32Array(n);
      frame.nodeRGBA = new Float32Array(n * 4);
      frame.nodeRing = new Uint8Array(n);
      nodeBase = new Float32Array(n * 4);
      mark = new Uint8Array(n);
      labels.opacity = new Float32Array(n);
      labels.order = new Uint32Array(n);
    } else {
      mark.fill(0);
    }
    frame.edgeSource = new Uint32Array(m);
    frame.edgeTarget = new Uint32Array(m);
    frame.edgeWidth = new Float32Array(m);
    frame.edgeRGBA = new Float32Array(m * 4);
    edgeBase = new Float32Array(m * 4);
    edgeBaseW = new Float32Array(m);
    for (let e = 0; e < m; e += 1) {
      const link = next.links[e]!;
      frame.edgeSource[e] = link.source;
      frame.edgeTarget[e] = link.target;
    }
    labels.text = next.nodes.map(nodeLabelText);
    const order = new Uint32Array(n);
    for (let i = 0; i < n; i += 1) order[i] = i;
    const nodes = next.nodes;
    order.sort((a, b) => nodes[b]!.degree - nodes[a]!.degree || a - b);
    degreeOrder = order;
    if (frame.x.length < n) {
      frame.x = new Float32Array(n);
      frame.y = new Float32Array(n);
    }
    if (!keep) {
      // Indices from the previous model are meaningless now.
      hovered = -1;
      selected = -1;
      highlightNode = -1;
      highlight = 0;
    }
    appliedStyle = -1;
    appliedHNode = -2;
    orderNode = -2;
  }

  function setStyle(
    groupColors: ReadonlyArray<string | null>,
    palette: GraphPalette,
    settings: GraphSettings,
  ): void {
    if (model) {
      const nodes = model.nodes;
      for (let i = 0; i < n; i += 1) {
        const node = nodes[i]!;
        frame.radius[i] = nodeRadius(node.degree, settings.nodeSize);
        writeCssColor(groupColors[i] ?? kindColor(node.kind, palette), nodeBase, i * 4);
      }
      const links = model.links;
      for (let e = 0; e < m; e += 1) {
        writeCssColor(palette.line, edgeBase, e * 4);
        edgeBaseW[e] = edgeBaseWidth(links[e]!.count, settings.linkThickness);
      }
    }
    writeCssColor(palette.focused, focused, 0);
    frame.ringRGBA.set(focused);
    frame.arrows = settings.showArrows;
    labels.color = palette.label;
    textFadeThreshold = settings.textFadeThreshold;
    styleVersion += 1;
    appliedK = NaN;
  }

  function setPositions(x: Float32Array, y: Float32Array): void {
    frame.x = x;
    frame.y = y;
  }

  function setHovered(index: number): void {
    const next = index >= 0 && index < n ? index : -1;
    hovered = next;
    if (next >= 0) highlightNode = next;
  }

  function setSelected(index: number): void {
    selected = index >= 0 && index < n ? index : -1;
  }

  function stepHighlight(dtMs: number): boolean {
    const target = hovered >= 0 ? 1 : 0;
    if (highlight !== target) {
      const step = dtMs > 0 ? dtMs / HOVER_FADE_MS : 0;
      highlight = target === 1 ? Math.min(1, highlight + step) : Math.max(0, highlight - step);
    }
    if (highlight === 0 && hovered < 0) highlightNode = -1;
    return isHighlightAnimating();
  }

  function isHighlightAnimating(): boolean {
    return highlight !== (hovered >= 0 ? 1 : 0);
  }

  /** Mark `highlightNode` + neighbours and rebuild the label priority order. */
  function rebuildMarksAndOrder(): void {
    mark.fill(0);
    const order = labels.order;
    let w = 0;
    const h = highlightNode;
    if (model && h >= 0) {
      mark[h] = 2;
      order[w++] = h;
      const adj = model.adjacency[h];
      if (adj) {
        for (let a = 0; a < adj.length; a += 1) {
          const j = adj[a]!;
          if (mark[j] === 0) {
            mark[j] = 2;
            order[w++] = j;
          }
        }
      }
    }
    for (let o = 0; o < degreeOrder.length; o += 1) {
      const i = degreeOrder[o]!;
      if (mark[i] === 0) order[w++] = i;
    }
    for (let i = 0; i < n; i += 1) if (mark[i] === 2) mark[i] = 1;
    orderNode = h;
    orderVersion = modelVersion;
  }

  function update(camera: CameraState, viewport: ViewportSize, dpr: number): void {
    frame.camera.x = camera.x;
    frame.camera.y = camera.y;
    frame.camera.k = camera.k;
    frame.viewport.width = viewport.width;
    frame.viewport.height = viewport.height;
    frame.dpr = dpr;

    const k = camera.k;
    const hNode = highlightNode;
    const h = hNode >= 0 ? highlight : 0;
    if (orderNode !== hNode || orderVersion !== modelVersion) rebuildMarksAndOrder();

    // Colours: only when highlight, its centre, or style changed.
    if (appliedStyle !== styleVersion || appliedH !== h || appliedHNode !== hNode) {
      const dimNode = 1 + (HOVER_NODE_DIM - 1) * h;
      const dimEdge = 1 + (HOVER_EDGE_DIM - 1) * h;
      const rgba = frame.nodeRGBA;
      if (h === 0) {
        rgba.set(nodeBase);
      } else {
        for (let i = 0; i < n; i += 1) {
          const o = i * 4;
          rgba[o] = nodeBase[o]!;
          rgba[o + 1] = nodeBase[o + 1]!;
          rgba[o + 2] = nodeBase[o + 2]!;
          rgba[o + 3] = mark[i] === 1 ? nodeBase[o + 3]! : nodeBase[o + 3]! * dimNode;
        }
      }
      const ergba = frame.edgeRGBA;
      if (h === 0) {
        ergba.set(edgeBase);
      } else {
        const src = frame.edgeSource;
        const dst = frame.edgeTarget;
        for (let e = 0; e < m; e += 1) {
          const o = e * 4;
          if (src[e] === hNode || dst[e] === hNode) {
            ergba[o] = edgeBase[o]! + (focused[0]! - edgeBase[o]!) * h;
            ergba[o + 1] = edgeBase[o + 1]! + (focused[1]! - edgeBase[o + 1]!) * h;
            ergba[o + 2] = edgeBase[o + 2]! + (focused[2]! - edgeBase[o + 2]!) * h;
            ergba[o + 3] = edgeBase[o + 3]! + (focused[3]! - edgeBase[o + 3]!) * h;
          } else {
            ergba[o] = edgeBase[o]!;
            ergba[o + 1] = edgeBase[o + 1]!;
            ergba[o + 2] = edgeBase[o + 2]!;
            ergba[o + 3] = edgeBase[o + 3]! * dimEdge;
          }
        }
      }
    }

    // Edge widths: zoom-dependent.
    if (appliedK !== k || appliedStyle !== styleVersion) {
      const widths = frame.edgeWidth;
      for (let e = 0; e < m; e += 1) widths[e] = edgeScreenWidth(edgeBaseW[e]!, k);
    }

    // Labels: zoom fade × node dim; hovered + neighbours → opaque.
    if (
      appliedK !== k ||
      appliedFadeH !== h ||
      appliedHNode !== hNode ||
      appliedStyle !== styleVersion
    ) {
      const fade = labelFadeOpacity(k, textFadeThreshold);
      const dimNode = 1 + (HOVER_NODE_DIM - 1) * h;
      const op = labels.opacity;
      for (let i = 0; i < n; i += 1) {
        op[i] = mark[i] === 1 ? fade + (1 - fade) * h : fade * dimNode;
      }
      appliedFadeH = h;
    }

    // Focus rings: selected + hovered.
    const ring = frame.nodeRing;
    ring.fill(0);
    if (selected >= 0) ring[selected] = 1;
    if (hovered >= 0) ring[hovered] = 1;

    appliedStyle = styleVersion;
    appliedH = h;
    appliedHNode = hNode;
    appliedK = k;
  }

  return {
    frame,
    labels,
    get highlight() {
      return highlight;
    },
    get highlightNode() {
      return highlightNode;
    },
    get hovered() {
      return hovered;
    },
    get nodeCount() {
      return n;
    },
    setModel,
    setStyle,
    setPositions,
    setHovered,
    setSelected,
    stepHighlight,
    isHighlightAnimating,
    update,
  };
}
