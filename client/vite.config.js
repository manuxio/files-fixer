import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // WebSocket first (more specific): the Claude web-shell PTY.
      '/api/terminal': { target: 'ws://localhost:3000', ws: true },
      '/api': 'http://localhost:3000',
    },
  },
  build: { outDir: 'dist', chunkSizeWarningLimit: 2000 },
});
