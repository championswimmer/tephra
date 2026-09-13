import { describe, expect, it } from 'vitest';

import type { GraphModel } from '../src/model';
import { MAX_VISIBLE_NODES, visibleNodeBudget } from '../src/visibility';

/** Minimal model with the given per-index degrees (no links needed). */
function modelWithDegrees(degrees: number[]): GraphModel {
  return {
    nodes: degrees.map((degree, i) => ({
      id: `n${i}`,
      path: `n${i}.md`,
      title: null,
      kind: 'note' as const,
      tags: [],
      degree,
    })),
    links: [],
    adjacency: degrees.map(() => new Uint32Array()),
    indexById: new Map(degrees.map((_, i) => [`n${i}`, i])),
  };
}

const allInView = (): boolean => true;

function visibleIndices(visible: Uint8Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < visible.length; i += 1) {
    if (visible[i] === 1) out.push(i);
  }
  return out;
}

describe('MAX_VISIBLE_NODES', () => {
  it('is the 500-node budget from the plan', () => {
    expect(MAX_VISIBLE_NODES).toBe(500);
  });
});

describe('visibleNodeBudget', () => {
  it('respects the budget and reports the hidden count', () => {
    const model = modelWithDegrees([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    const { visible, hiddenCount } = visibleNodeBudget(model, allInView, 3);
    expect(visibleIndices(visible)).toHaveLength(3);
    expect(hiddenCount).toBe(7);
  });

  it('picks highest-degree nodes first', () => {
    const model = modelWithDegrees([1, 5, 3]);
    const { visible, hiddenCount } = visibleNodeBudget(model, allInView, 2);
    expect(visibleIndices(visible)).toEqual([1, 2]);
    expect(hiddenCount).toBe(1);
  });

  it('breaks degree ties by node index (deterministic)', () => {
    const model = modelWithDegrees([4, 4, 4]);
    const first = visibleNodeBudget(model, allInView, 1);
    const second = visibleNodeBudget(model, allInView, 1);
    expect(visibleIndices(first.visible)).toEqual([0]);
    expect(visibleIndices(second.visible)).toEqual([0]);
    expect(first.hiddenCount).toBe(2);
  });

  it('applies the budget to in-view nodes only', () => {
    // Highest-degree node is off-screen: the budget skips it and keeps the
    // best in-view nodes instead.
    const model = modelWithDegrees([9, 5, 3, 1]);
    const isInView = (index: number): boolean => index !== 0;
    const { visible, hiddenCount } = visibleNodeBudget(model, isInView, 2);
    expect(visibleIndices(visible)).toEqual([1, 2]);
    expect(hiddenCount).toBe(1);
  });

  it('force-includes selected/hovered indices over budget', () => {
    const model = modelWithDegrees([9, 5, 1]);
    const { visible, hiddenCount } = visibleNodeBudget(
      model,
      allInView,
      1,
      new Set([2]),
    );
    // Budget winner (index 0) plus the forced index — over budget by design.
    expect(visibleIndices(visible)).toEqual([0, 2]);
    expect(hiddenCount).toBe(1);
  });

  it('force-includes off-screen indices without hiding in-view nodes', () => {
    const model = modelWithDegrees([9, 5]);
    const isInView = (index: number): boolean => index === 0;
    const { visible, hiddenCount } = visibleNodeBudget(
      model,
      isInView,
      1,
      new Set([1]),
    );
    expect(visibleIndices(visible)).toEqual([0, 1]);
    expect(hiddenCount).toBe(0);
  });

  it('ignores out-of-range force indices', () => {
    const model = modelWithDegrees([2, 1]);
    const { visible, hiddenCount } = visibleNodeBudget(
      model,
      allInView,
      2,
      new Set([-1, 99]),
    );
    expect(visibleIndices(visible)).toEqual([0, 1]);
    expect(hiddenCount).toBe(0);
  });

  it('keeps everything when the budget covers the model', () => {
    const model = modelWithDegrees([3, 1]);
    const { visible, hiddenCount } = visibleNodeBudget(model, allInView, 500);
    expect(visibleIndices(visible)).toEqual([0, 1]);
    expect(hiddenCount).toBe(0);
  });

  it('handles a zero budget (only force stays visible)', () => {
    const model = modelWithDegrees([3, 1]);
    const { visible, hiddenCount } = visibleNodeBudget(
      model,
      allInView,
      0,
      new Set([1]),
    );
    expect(visibleIndices(visible)).toEqual([1]);
    expect(hiddenCount).toBe(1);
  });

  it('handles empty and single-node models', () => {
    const empty = visibleNodeBudget(modelWithDegrees([]), allInView, 500);
    expect(empty.visible).toHaveLength(0);
    expect(empty.hiddenCount).toBe(0);

    const single = visibleNodeBudget(modelWithDegrees([7]), allInView, 500);
    expect(visibleIndices(single.visible)).toEqual([0]);
    expect(single.hiddenCount).toBe(0);
  });

  it('accepts a pre-sorted order (renderer labelOrder reuse)', () => {
    const model = modelWithDegrees([1, 5, 3]);
    const order = [1, 2, 0];
    const { visible, hiddenCount } = visibleNodeBudget(
      model,
      allInView,
      2,
      new Set(),
      order,
    );
    expect(visibleIndices(visible)).toEqual([1, 2]);
    expect(hiddenCount).toBe(1);
  });
});
