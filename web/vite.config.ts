import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// Resolve the shared workspace package straight to its TypeScript source so the
// dev server and build pick up changes without a separate build step.
export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    VitePWA({
      // Capacitor (`--mode mobile`) ships a native app loaded from
      // https://localhost — a service worker there is pointless and can cache
      // stale assets, so the PWA layer is only for the same-origin web deploy.
      disable: mode === 'mobile',
      // Auto-update: a new deploy's service worker activates and reloads on the
      // next visit without any user prompt — right for a realtime game where a
      // stale client could desync from the server's event contracts.
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: ['favicon-32.png', 'apple-touch-icon.png'],
      manifest: {
        name: 'Tichu',
        short_name: 'Tichu',
        description: '온라인으로 즐기는 실시간 티츄 (4인 2팀 카드 게임)',
        lang: 'ko',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#0f1115',
        theme_color: '#0f1115',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          {
            src: 'icon-512-maskable.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // Precache the built app shell. The Socket.IO connection is never
        // cached (it's a live WebSocket, not a fetch), so realtime play is
        // unaffected; this only makes the shell load instantly and installable.
        globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
        // SPA fallback so deep links resolve to index.html from the cache.
        navigateFallback: '/index.html',
      },
    }),
  ],
  resolve: {
    alias: {
      '@tichu/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  server: {
    port: 5173,
  },
}));
