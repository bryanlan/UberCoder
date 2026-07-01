import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

const backendPort = process.env.AGENT_CONSOLE_E2E_SERVER_PORT ?? '4317';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      workbox: {
        navigateFallbackDenylist: [/^\/api\//, /^\/proxy\//],
      },
      manifest: {
        name: 'Agent Console',
        short_name: 'Agent Console',
        description: 'Server-first control plane for local Codex and Claude sessions.',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/pwa-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
    }),
  ],
  server: {
    port: 5178,
    proxy: {
      '/api': `http://127.0.0.1:${backendPort}`,
      '/proxy': `http://127.0.0.1:${backendPort}`,
    },
  },
  build: {
    outDir: 'dist',
  },
});
