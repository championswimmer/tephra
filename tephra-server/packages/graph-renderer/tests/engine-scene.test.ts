import { describe, expect, it } from 'vitest';

import { buildGraphModel, type GraphModel } from '../src/model';
import type { GraphPalette } from '../src/palette';
import { DEFAULT_GRAPH_SETTINGS, type GraphSettings } from '../src/settings';
import {
  createScene,
  edgeBaseWidth,
  edgeScreenWidth,
  HOVER_FADE_MS,
  MAX_LABELS,
  nodeLabelText,
} from '../src/engine/scene';

const palette: GraphPalette = {
  node: '#ff0000',
  tag: '#ff00ff',
  attachment: '#ffff00',
  unresolved: '#808080',
  focused: '#0000ff',
  line: '#00ff00',
  label: '#123456',
};

const settings: GraphSettings = { ...DEFAULT_GRAPH_SETTINGS, textFadeThreshold: 0.5 };

/** a—b, a—c, c—d: hovering `a` makes b, c neighbours and d "other". */
function model(): GraphModel {
  return buildGraphModel({
    nodes: [
      { id: 'a', path: 'notes/Alpha.md', title: 'Alpha', kind: 'note', tags: [] },
      { id: 'b', path: 'notes/Beta.md', title: null, kind: 'note', tags: [] },
      { id: 'c', path: '', title: null, kind: 'note', tags: [] },
      { id: 'tag:d', path: '', title: 'd', kind: 'tag', tags: [] },
    ],
    edges: [
      { s: 0, t: 1, count: 1, embeds: 0 },
      { s: 0, t: 2, count: 4, embeds: 0 },
      { s: 2, t: 3, count: 1, embeds: 0 },
    ],
  });
}

const camera = { x: 0, y: 0, k: 1.5 };
const viewport = { width: 800, height: 600 };

function setup() {
  const scene = createScene();
  const m = model();
  scene.setModel(m);
  scene.setStyle([null, null, null, null], palette, settings);
  scene.setPositions(new Float32Array(4), new Float32Array(4));
  return { scene, m };
}

function nodeAlpha(scene: ReturnType<typeof createScene>, i: number): number {
  return scene.frame.nodeRGBA[i * 4 + 3]!;
}

function edgeColor(scene: ReturnType<typeof createScene>, e: number): number[] {
  return Array.from(scene.frame.edgeRGBA.slice(e * 4, e * 4 + 4));
}

describe('scene highlight maths', () => {
  it('h = 0: base colours, no dimming', () => {
    const { scene } = setup();
    scene.update(camera, viewport, 1);
    for (let i = 0; i < 4; i += 1) expect(nodeAlpha(scene, i)).toBeCloseTo(1);
    expect(Array.from(scene.frame.nodeRGBA.slice(0, 4))).toEqual([1, 0, 0, 1]);
    // Tag node uses the tag colour.
    expect(Array.from(scene.frame.nodeRGBA.slice(12, 16))).toEqual([1, 0, 1, 1]);
    for (let e = 0; e < 3; e += 1) expect(edgeColor(scene, e)).toEqual([0, 1, 0, 1]);
    expect(Array.from(scene.frame.nodeRing)).toEqual([0, 0, 0, 0]);
    expect(Array.from(scene.frame.ringRGBA)).toEqual([0, 0, 1, 1]);
  });

  it('h = 0.5 and h = 1 while hovering: neighbours opaque, others dimmed, edges focused', () => {
    const { scene } = setup();
    scene.setHovered(0);
    expect(scene.stepHighlight(HOVER_FADE_MS / 2)).toBe(true);
    expect(scene.highlight).toBeCloseTo(0.5);
    scene.update(camera, viewport, 1);
    expect(nodeAlpha(scene, 0)).toBeCloseTo(1);
    expect(nodeAlpha(scene, 1)).toBeCloseTo(1);
    expect(nodeAlpha(scene, 2)).toBeCloseTo(1);
    expect(nodeAlpha(scene, 3)).toBeCloseTo(0.6);
    const ab = edgeColor(scene, 0);
    expect(ab[0]).toBeCloseTo(0);
    expect(ab[1]).toBeCloseTo(0.5);
    expect(ab[2]).toBeCloseTo(0.5);
    expect(ab[3]).toBeCloseTo(1);
    expect(edgeColor(scene, 2)[3]).toBeCloseTo(0.55);
    expect(Array.from(scene.frame.nodeRing)).toEqual([1, 0, 0, 0]);

    expect(scene.stepHighlight(HOVER_FADE_MS)).toBe(false);
    expect(scene.highlight).toBe(1);
    scene.update(camera, viewport, 1);
    expect(nodeAlpha(scene, 3)).toBeCloseTo(0.2);
    expect(edgeColor(scene, 0)).toEqual([0, 0, 1, 1]);
    expect(edgeColor(scene, 1)).toEqual([0, 0, 1, 1]);
    const cd = edgeColor(scene, 2);
    expect(cd.slice(0, 3)).toEqual([0, 1, 0]);
    expect(cd[3]).toBeCloseTo(0.1);
  });

  it('fades back out around the last hovered node', () => {
    const { scene } = setup();
    scene.setHovered(0);
    scene.stepHighlight(HOVER_FADE_MS);
    scene.setHovered(-1);
    expect(scene.isHighlightAnimating()).toBe(true);
    scene.stepHighlight(HOVER_FADE_MS / 2);
    expect(scene.highlight).toBeCloseTo(0.5);
    expect(scene.highlightNode).toBe(0);
    scene.update(camera, viewport, 1);
    expect(nodeAlpha(scene, 3)).toBeCloseTo(0.6);
    expect(nodeAlpha(scene, 1)).toBeCloseTo(1);
    // Ring follows the live hover, not the fade.
    expect(Array.from(scene.frame.nodeRing)).toEqual([0, 0, 0, 0]);
    expect(scene.stepHighlight(HOVER_FADE_MS)).toBe(false);
    expect(scene.highlightNode).toBe(-1);
    scene.update(camera, viewport, 1);
    expect(nodeAlpha(scene, 3)).toBeCloseTo(1);
    expect(edgeColor(scene, 0)).toEqual([0, 1, 0, 1]);
  });

  it('rings selected and hovered nodes', () => {
    const { scene } = setup();
    scene.setSelected(3);
    scene.setHovered(1);
    scene.update(camera, viewport, 1);
    expect(Array.from(scene.frame.nodeRing)).toEqual([0, 1, 0, 1]);
  });

  it('style changes recolour without touching highlight state', () => {
    const { scene } = setup();
    scene.update(camera, viewport, 1);
    scene.setStyle(['#0000ff', null, null, null], { ...palette, line: '#ffffff' }, settings);
    scene.update(camera, viewport, 1);
    expect(Array.from(scene.frame.nodeRGBA.slice(0, 4))).toEqual([0, 0, 1, 1]);
    expect(edgeColor(scene, 0)).toEqual([1, 1, 1, 1]);
  });
});

describe('edge widths', () => {
  it('scales with count and zoom, clamped to [0.5, 8]', () => {
    expect(edgeBaseWidth(1, 1)).toBe(1);
    expect(edgeBaseWidth(4, 1)).toBe(3);
    expect(edgeBaseWidth(4, 2)).toBe(6);
    expect(edgeScreenWidth(3, 1)).toBe(3);
    expect(edgeScreenWidth(3, 4)).toBe(3);
    expect(edgeScreenWidth(3, 0.5)).toBe(1.5);
    expect(edgeScreenWidth(3, 0.1)).toBe(0.5);
    expect(edgeScreenWidth(100, 1)).toBe(8);
  });

  it('fills frame.edgeWidth per zoom', () => {
    const { scene } = setup();
    scene.update({ x: 0, y: 0, k: 0.5 }, viewport, 1);
    expect(Array.from(scene.frame.edgeWidth)).toEqual([0.5, 1.5, 0.5]);
    scene.update({ x: 0, y: 0, k: 2 }, viewport, 1);
    expect(Array.from(scene.frame.edgeWidth)).toEqual([1, 3, 1]);
  });
});

describe('labels', () => {
  it('derives label text from title, path basename, or id', () => {
    expect(nodeLabelText({ id: 'x', path: 'a/B.md', title: 'T' })).toBe('T');
    expect(nodeLabelText({ id: 'x', path: 'a/B.md', title: null })).toBe('B');
    expect(nodeLabelText({ id: 'x', path: 'a/pic.png', title: null })).toBe('pic.png');
    expect(nodeLabelText({ id: 'x', path: '', title: null })).toBe('x');
    const { scene } = setup();
    expect(scene.labels.text).toEqual(['Alpha', 'Beta', 'c', 'd']);
    expect(scene.labels.color).toBe('#123456');
    expect(scene.labels.maxLabels).toBe(MAX_LABELS);
  });

  it('opacity follows the zoom fade and the hover dim', () => {
    const { scene } = setup();
    // t = 0.5 * 2 = 1 → k = 1.5 gives 0.5.
    scene.update(camera, viewport, 1);
    for (let i = 0; i < 4; i += 1) expect(scene.labels.opacity[i]).toBeCloseTo(0.5);
    scene.update({ x: 0, y: 0, k: 0.5 }, viewport, 1);
    for (let i = 0; i < 4; i += 1) expect(scene.labels.opacity[i]).toBe(0);
    scene.setHovered(0);
    scene.stepHighlight(HOVER_FADE_MS);
    scene.update({ x: 0, y: 0, k: 0.5 }, viewport, 1);
    expect(Array.from(scene.labels.opacity)).toEqual([1, 1, 1, 0]);
    scene.update(camera, viewport, 1);
    expect(scene.labels.opacity[0]).toBe(1);
    expect(scene.labels.opacity[3]).toBeCloseTo(0.1);
  });

  it('orders labels hovered → neighbours → degree desc', () => {
    const { scene } = setup();
    scene.update(camera, viewport, 1);
    // Degrees: a=5, b=1, c=5, d=1 → ties by index.
    expect(Array.from(scene.labels.order)).toEqual([0, 2, 1, 3]);
    scene.setHovered(3);
    scene.stepHighlight(HOVER_FADE_MS);
    scene.update(camera, viewport, 1);
    expect(Array.from(scene.labels.order)).toEqual([3, 2, 0, 1]);
  });
});
