/**
 * CSS colour strings → RGBA floats (plan 018). Pure and DOM-optional: the
 * common syntaxes (`#hex`, `rgb()/rgba()`, `hsl()/hsla()`, a few named
 * colours) are parsed here; anything else falls back to a cached canvas-2d
 * `fillStyle` normalisation when a DOM exists, else opaque mid-grey.
 *
 * Output is straight (non-premultiplied) RGBA in [0, 1]. Parsed results are
 * cached in a bounded Map keyed by the input string, so per-frame callers pay
 * only a Map lookup.
 */

/** Maximum number of cached colour strings before the oldest is evicted. */
const CACHE_LIMIT = 256;

const cache = new Map<string, Float32Array>();

/** Mid-grey used when a colour cannot be parsed. */
const FALLBACK: readonly [number, number, number, number] = [0.5, 0.5, 0.5, 1];

const NAMED: Readonly<Record<string, readonly [number, number, number, number]>> = {
  transparent: [0, 0, 0, 0],
  black: [0, 0, 0, 1],
  white: [255, 255, 255, 1],
  red: [255, 0, 0, 1],
  green: [0, 128, 0, 1],
  lime: [0, 255, 0, 1],
  blue: [0, 0, 255, 1],
  yellow: [255, 255, 0, 1],
  cyan: [0, 255, 255, 1],
  aqua: [0, 255, 255, 1],
  magenta: [255, 0, 255, 1],
  fuchsia: [255, 0, 255, 1],
  gray: [128, 128, 128, 1],
  grey: [128, 128, 128, 1],
  silver: [192, 192, 192, 1],
  orange: [255, 165, 0, 1],
  purple: [128, 0, 128, 1],
};

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Write 0–255 RGB + 0–1 alpha into `dst` as floats. */
function store(dst: Float32Array, r: number, g: number, b: number, a: number): void {
  dst[0] = clamp01(r / 255);
  dst[1] = clamp01(g / 255);
  dst[2] = clamp01(b / 255);
  dst[3] = clamp01(a);
}

function parseHex(s: string, dst: Float32Array): boolean {
  const hex = s.slice(1);
  if (!/^[0-9a-f]+$/i.test(hex)) return false;
  const n = hex.length;
  if (n === 3 || n === 4) {
    const c = (i: number): number => parseInt(hex.charAt(i) + hex.charAt(i), 16);
    store(dst, c(0), c(1), c(2), n === 4 ? c(3) / 255 : 1);
    return true;
  }
  if (n === 6 || n === 8) {
    const c = (i: number): number => parseInt(hex.slice(i, i + 2), 16);
    store(dst, c(0), c(2), c(4), n === 8 ? c(6) / 255 : 1);
    return true;
  }
  return false;
}

/** Split a functional-notation body into components + optional alpha. */
function splitArgs(body: string): { parts: string[]; alpha: string | undefined } | null {
  let main = body.trim();
  let alpha: string | undefined;
  const slash = main.indexOf('/');
  if (slash >= 0) {
    alpha = main.slice(slash + 1).trim();
    main = main.slice(0, slash).trim();
  }
  const parts = (main.includes(',') ? main.split(',') : main.split(/\s+/))
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 4 && alpha === undefined) alpha = parts.pop();
  if (parts.length !== 3) return null;
  return { parts, alpha };
}

/** Parse a number, optionally `%`-suffixed; `%` maps 100% → `percentScale`. */
function num(token: string, percentScale: number): number {
  if (token.endsWith('%')) return (parseFloat(token) / 100) * percentScale;
  return parseFloat(token);
}

function parseAlpha(token: string | undefined): number {
  if (token === undefined) return 1;
  return num(token, 1);
}

function parseHue(token: string): number {
  const v = parseFloat(token);
  if (token.endsWith('turn')) return v * 360;
  if (token.endsWith('grad')) return v * 0.9;
  if (token.endsWith('rad')) return (v * 180) / Math.PI;
  return v;
}

function parseRgb(body: string, dst: Float32Array): boolean {
  const args = splitArgs(body);
  if (!args) return false;
  const [rs, gs, bs] = args.parts as [string, string, string];
  const r = num(rs, 255);
  const g = num(gs, 255);
  const b = num(bs, 255);
  const a = parseAlpha(args.alpha);
  if (![r, g, b, a].every(Number.isFinite)) return false;
  store(dst, r, g, b, a);
  return true;
}

function parseHsl(body: string, dst: Float32Array): boolean {
  const args = splitArgs(body);
  if (!args) return false;
  const [hs, ss, ls] = args.parts as [string, string, string];
  const h = (((parseHue(hs) % 360) + 360) % 360) / 360;
  const s = clamp01(parseFloat(ss) / 100);
  const l = clamp01(parseFloat(ls) / 100);
  const a = parseAlpha(args.alpha);
  if (![h, s, l, a].every(Number.isFinite)) return false;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t: number): number => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  store(dst, hue(h + 1 / 3) * 255, hue(h) * 255, hue(h - 1 / 3) * 255, a);
  return true;
}

/** Parse the syntaxes handled natively. Returns false if unrecognised. */
function parseNative(css: string, dst: Float32Array): boolean {
  const s = css.trim().toLowerCase();
  if (s.length === 0) return false;
  if (s.charAt(0) === '#') return parseHex(s, dst);
  const named = NAMED[s];
  if (named) {
    store(dst, named[0], named[1], named[2], named[3]);
    return true;
  }
  const fn = /^(rgba?|hsla?)\((.*)\)$/.exec(s);
  if (!fn) return false;
  const body = fn[2] ?? '';
  return fn[1]!.startsWith('rgb') ? parseRgb(body, dst) : parseHsl(body, dst);
}

let probe: CanvasRenderingContext2D | null | undefined;

/** Lazily created 2D context used to normalise exotic CSS colours. */
function probeContext(): CanvasRenderingContext2D | null {
  if (probe !== undefined) return probe;
  probe = null;
  try {
    if (typeof document !== 'undefined') {
      probe = document.createElement('canvas').getContext('2d');
    }
  } catch {
    probe = null;
  }
  return probe;
}

/** Normalise via canvas `fillStyle` (handles every CSS colour keyword). */
function parseViaCanvas(css: string, dst: Float32Array): boolean {
  const ctx = probeContext();
  if (!ctx) return false;
  // Two different sentinels detect strings the canvas rejects.
  ctx.fillStyle = '#000000';
  ctx.fillStyle = css;
  const a = String(ctx.fillStyle);
  ctx.fillStyle = '#ffffff';
  ctx.fillStyle = css;
  const b = String(ctx.fillStyle);
  if (a !== b) return false;
  return parseNative(a, dst);
}

function resolve(css: string): Float32Array {
  const hit = cache.get(css);
  if (hit) return hit;
  const rgba = new Float32Array(4);
  if (!parseNative(css, rgba) && !parseViaCanvas(css, rgba)) {
    rgba.set(FALLBACK);
  }
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(css, rgba);
  return rgba;
}

/**
 * Write the RGBA floats for `css` into `out[offset..offset+3]` (straight
 * alpha in [0, 1]); alpha is multiplied by `alphaMul` (default 1).
 * Unparseable strings yield opaque mid-grey.
 */
export function writeCssColor(css: string, out: Float32Array, offset: number, alphaMul = 1): void {
  const c = resolve(css);
  out[offset] = c[0]!;
  out[offset + 1] = c[1]!;
  out[offset + 2] = c[2]!;
  out[offset + 3] = c[3]! * alphaMul;
}

/**
 * Format float RGBA (each in [0, 1], straight alpha) as a CSS
 * `rgba(r,g,b,a)` string with 0–255 integer channels.
 */
export function rgbaToCss(r: number, g: number, b: number, a: number): string {
  const R = Math.round(clamp01(r) * 255);
  const G = Math.round(clamp01(g) * 255);
  const B = Math.round(clamp01(b) * 255);
  const A = Math.round(clamp01(a) * 1000) / 1000;
  return `rgba(${R},${G},${B},${A})`;
}

/** Test hook: number of cached colour strings. */
export function colorCacheSize(): number {
  return cache.size;
}
