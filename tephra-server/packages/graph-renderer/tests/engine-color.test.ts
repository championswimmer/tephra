import { describe, expect, it } from 'vitest';

import { colorCacheSize, rgbaToCss, writeCssColor } from '../src/engine/color';

function parse(css: string, alphaMul?: number): number[] {
  const out = new Float32Array(4);
  writeCssColor(css, out, 0, alphaMul);
  return Array.from(out, (v) => Math.round(v * 1000) / 1000);
}

const GREY = [0.502, 0.502, 0.502, 1];

describe('writeCssColor', () => {
  it('parses hex forms', () => {
    expect(parse('#f00')).toEqual([1, 0, 0, 1]);
    expect(parse('#0f08')).toEqual([0, 1, 0, 0.533]);
    expect(parse('#336699')).toEqual([0.2, 0.4, 0.6, 1]);
    expect(parse('#33669980')).toEqual([0.2, 0.4, 0.6, 0.502]);
    expect(parse('#FFFFFF')).toEqual([1, 1, 1, 1]);
  });

  it('parses rgb()/rgba() in comma and space syntax', () => {
    expect(parse('rgb(255, 0, 0)')).toEqual([1, 0, 0, 1]);
    expect(parse('rgba(0,0,255,0.5)')).toEqual([0, 0, 1, 0.5]);
    expect(parse('rgb(0 255 0 / 25%)')).toEqual([0, 1, 0, 0.25]);
    expect(parse('rgb(100% 50% 0%)')).toEqual([1, 0.5, 0, 1]);
    expect(parse('rgba(0 0 0 / 0.3)')).toEqual([0, 0, 0, 0.3]);
  });

  it('parses hsl()/hsla()', () => {
    expect(parse('hsl(0, 100%, 50%)')).toEqual([1, 0, 0, 1]);
    expect(parse('hsl(120 100% 50%)')).toEqual([0, 1, 0, 1]);
    expect(parse('hsla(240, 100%, 50%, 0.5)')).toEqual([0, 0, 1, 0.5]);
    expect(parse('hsl(0.5turn 0% 100% / 50%)')).toEqual([1, 1, 1, 0.5]);
  });

  it('parses named colours and transparent', () => {
    expect(parse('black')).toEqual([0, 0, 0, 1]);
    expect(parse('White')).toEqual([1, 1, 1, 1]);
    expect(parse('red')).toEqual([1, 0, 0, 1]);
    expect(parse('gray')).toEqual(GREY);
    expect(parse('grey')).toEqual(GREY);
    expect(parse('transparent')).toEqual([0, 0, 0, 0]);
  });

  it('falls back to opaque mid-grey without a DOM', () => {
    expect(parse('not-a-colour')).toEqual([0.5, 0.5, 0.5, 1]);
    expect(parse('#12')).toEqual([0.5, 0.5, 0.5, 1]);
    expect(parse('rgb(1, 2)')).toEqual([0.5, 0.5, 0.5, 1]);
  });

  it('multiplies alpha and writes at an offset', () => {
    const out = new Float32Array(8).fill(9);
    writeCssColor('rgba(255,255,255,0.5)', out, 4, 0.5);
    expect(Array.from(out)).toEqual([9, 9, 9, 9, 1, 1, 1, 0.25]);
  });

  it('caches results with a bounded size', () => {
    parse('#abcdef');
    const before = colorCacheSize();
    parse('#abcdef');
    expect(colorCacheSize()).toBe(before);
    for (let i = 0; i < 600; i++) parse(`rgb(${i % 256}, 1, ${i})`);
    expect(colorCacheSize()).toBeLessThanOrEqual(256);
    // Cached values are not corrupted by alphaMul.
    expect(parse('#abcdef', 0)[3]).toBe(0);
    expect(parse('#abcdef')[3]).toBe(1);
  });
});

describe('rgbaToCss', () => {
  it('formats float RGBA as css', () => {
    expect(rgbaToCss(1, 0, 0.5, 0.25)).toBe('rgba(255,0,128,0.25)');
    expect(rgbaToCss(2, -1, 0, 1)).toBe('rgba(255,0,0,1)');
  });
});
