import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Resolve the shared workspace package straight to its TypeScript source so the
// dev server and build pick up changes without a separate build step.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@tichu/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  server: {
    port: 5173,
  },
});
