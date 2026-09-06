import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventBuffer } from '../src/sync/event-buffer';

describe('EventBuffer', () => {
  afterEach(() => vi.useRealTimers());

  it('coalesces repeated modifications and flushes at debounce', () => {
    vi.useFakeTimers();
    const flush = vi.fn();
    const buffer = new EventBuffer(flush, 2_000, 10_000);
    buffer.add({ type: 'modify', path: 'A.md' });
    buffer.add({ type: 'modify', path: 'A.md' });
    buffer.add({ type: 'modify', path: 'B.md' });
    vi.advanceTimersByTime(1_999);
    expect(flush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(flush).toHaveBeenCalledWith([
      { type: 'modify', path: 'A.md' },
      { type: 'modify', path: 'B.md' },
    ]);
  });

  it('preserves rename intent when a modify follows it', () => {
    vi.useFakeTimers();
    const flush = vi.fn();
    const buffer = new EventBuffer(flush, 100, 1_000);
    buffer.add({ type: 'rename', oldPath: 'Old.md', path: 'New.md' });
    buffer.add({ type: 'modify', path: 'New.md' });
    vi.advanceTimersByTime(100);
    expect(flush).toHaveBeenCalledWith([{ type: 'rename', oldPath: 'Old.md', path: 'New.md' }]);
  });

  it('does not postpone a busy stream past the maximum delay', () => {
    vi.useFakeTimers();
    const flush = vi.fn();
    const buffer = new EventBuffer(flush, 2_000, 10_000);
    buffer.add({ type: 'modify', path: 'A.md' });
    for (let index = 0; index < 5; index += 1) {
      vi.advanceTimersByTime(1_900);
      buffer.add({ type: 'modify', path: 'A.md' });
    }
    vi.advanceTimersByTime(500);
    expect(flush).toHaveBeenCalledTimes(1);
  });
});
