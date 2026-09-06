import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { '/api': 'http://localhost:3000' },
  },
  test: {
    environment: 'jsdom',
    setupFiles: './tests/setup.ts',
    css: false,
    // Playwright end-to-end specs live in ./e2e and must not run under vitest
    // (Playwright's test() collides with vitest's runner).
    exclude: ['**/node_modules/**', '**/dist/**', 'e2e/**'],
  },
});
