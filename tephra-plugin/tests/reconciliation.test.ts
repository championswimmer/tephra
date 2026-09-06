import { describe, expect, it, vi } from 'vitest';
import { SerializedReconciler } from '../src/sync/reconciliation';

describe('SerializedReconciler', () => {
  it('serializes work and performs one follow-up for requests made while running', async () => {
    let release: (() => void) | undefined;
    let active = 0;
    let maximumActive = 0;
    const reconcile = vi.fn(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (reconcile.mock.calls.length === 1) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      active -= 1;
    });
    const queue = new SerializedReconciler(reconcile);
    const first = queue.request();
    const second = queue.request();
    release?.();
    await Promise.all([first, second]);
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(maximumActive).toBe(1);
  });
});
