import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';

// `npm run dev` serves the pages from here and forwards /api and /ws to a running
// backend. Which one, in order:
//   1. BACKEND in the shell or in frontend/.env      e.g. BACKEND=https://192.81.135.162
//   2. https://<PUBLIC_IP> from the repo's .env        the docker stack on this machine
//   3. https://127.0.0.1
// The backend's cert is self-signed, so `secure: false`. Video packets go straight to
// the backend's ip:7882 the same way they would from its own pages.
export default defineConfig(({ mode }) => {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const own = loadEnv(mode, here, '');
  const repo = loadEnv(mode, repoRoot, '');
  const backend = (process.env.BACKEND || own.BACKEND || `https://${repo.PUBLIC_IP || '127.0.0.1'}`).replace(/\/$/, '');
  console.log(`  backend: ${backend}   (BACKEND=... to change)`);

  return {
    plugins: [react()],
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) }
    },
    server: {
      // an odd port on purpose: 3000 is usually taken by something else
      port: 42069,
      proxy: {
        '/api': { target: backend, changeOrigin: true, secure: false },
        '/ws': { target: backend.replace(/^http/, 'ws'), ws: true, changeOrigin: true, secure: false }
      }
    },
    build: {
      outDir: 'dist',
      sourcemap: false
    }
  };
});
