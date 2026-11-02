import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `npm run dev` proxies the bridge API, so the app can be developed against a bridge started with
// `npm run dev:bridge` (its own device list in .dev/; add demo DSPs from the Connection screen).
const bridge = process.env.DSP_BRIDGE ?? 'http://localhost:8080';

export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': bridge,
      '/ws': { target: bridge.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: { outDir: 'dist', target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 900 },
});
