import { describe, expect, it } from 'vitest';
import type { Clock } from '../src/index.js';
import { UuidV7Generator } from '../src/index.js';

class FixedClock implements Clock {
  constructor(private readonly timestamp: number) {}
  now(): number {
    return this.timestamp;
  }
}

describe('UuidV7Generator', () => {
  it('creates an RFC-compatible version 7 UUID', () => {
    const id = new UuidV7Generator(new FixedClock(1_788_640_000_000)).generate();
    expect(id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  });

  it('sorts IDs generated at different timestamps', () => {
    const earlier = new UuidV7Generator(new FixedClock(1)).generate();
    const later = new UuidV7Generator(new FixedClock(2)).generate();
    expect(earlier < later).toBe(true);
  });
});
