import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/** Porta do servidor agent-office usada pelo proxy em desenvolvimento. */
const port = process.env.AGENT_OFFICE_PORT ?? '4747';
const target = `http://127.0.0.1:${port}`;

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: '/',
  resolve: {
    alias: {
      '@agent-office/server/schema': fileURLToPath(new URL('../server/src/schema.ts', import.meta.url)),
    },
  },
  // JSX pelo transformador embutido do Vite (sem @vitejs/plugin-react).
  oxc: { jsx: { runtime: 'automatic', importSource: 'react' } },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/ws': { target: `ws://127.0.0.1:${port}`, ws: true },
      '/api': target,
      '/events': target,
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
});
