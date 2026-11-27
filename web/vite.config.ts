import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The customer app is served by the API service itself (same origin, no new hosting).
// In development, `npm run web:dev` proxies /v1 to the API on port 3000.
export default defineConfig({
  root: __dirname,
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
  server: { port: 5173, proxy: { '/v1': 'http://localhost:3000' } },
});
