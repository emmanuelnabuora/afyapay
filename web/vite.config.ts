import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// The customer app (/), insurer portal (/insurer/) and staff admin (/admin/) are served by the API service itself (same origin, no new hosting).
// In development, `npm run web:dev` proxies /v1 to the API on port 3000.
export default defineConfig({
  root: __dirname,
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: { input: { app: resolve(__dirname, 'index.html'), insurer: resolve(__dirname, 'insurer/index.html'), admin: resolve(__dirname, 'admin/index.html') } },
  },
  server: { port: 5173, proxy: { '/v1': 'http://localhost:3000' } },
});
