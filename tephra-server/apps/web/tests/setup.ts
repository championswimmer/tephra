import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

// Sigma's WebGL buffer module reads `WebGL2RenderingContext` constants at
// import time. jsdom provides no WebGL, and these tests stub <TephraGraph>
// anyway, so a minimal constants object keeps the package importable.
for (const name of ['WebGL2RenderingContext', 'WebGLRenderingContext'] as const) {
  const record = globalThis as Record<string, unknown>;
  if (typeof record[name] === 'undefined') {
    record[name] = {
      BOOL: 0x8b56,
      BYTE: 0x1400,
      UNSIGNED_BYTE: 0x1401,
      SHORT: 0x1402,
      UNSIGNED_SHORT: 0x1403,
      INT: 0x1404,
      UNSIGNED_INT: 0x1405,
      FLOAT: 0x1406,
    };
  }
}

// Under Node ≥ 22.4 / 24 the runtime ships a process-level `localStorage`
// accessor (`internal/webstorage`, throws without --localstorage-file) that
// overwrites jsdom's own `window.localStorage` data property on the vitest
// global. Rebind the real jsdom storage from the `globalThis.jsdom` handle
// that vitest's jsdom environment publishes.
{
  const record = globalThis as Record<string, unknown>;
  const dom = record.jsdom as { window?: Record<string, unknown> } | undefined;
  const real = dom?.window?.localStorage;
  if (real && typeof real === 'object') {
    try {
      Object.defineProperty(record, 'localStorage', {
        value: real,
        writable: true,
        configurable: true,
      });
    } catch {
      // If the binding is somehow non-configurable, tests fall back to
      // `window.localStorage` via the component's own default storage.
    }
  }
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
