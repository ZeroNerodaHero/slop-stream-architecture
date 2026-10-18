import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';

// `npm run dev` serves the pages from here and forwards /api and /ws to the running docker
// stack at https://<PUBLIC_IP> (self-signed, so `secure: false`). PUBLIC_IP comes from the
// repo's .env, the one deploy.sh writes. Video packets still go straight to <PUBLIC_IP>:7882.
export default defineConfig(({ mode }) => {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const env = loadEnv(mode, repoRoot, '');
  const backend = `https://${env.PUBLIC_IP || '127.0.0.1'}`;

  return {
    plugins: [react()],
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) }
    },
    server: {
      port: 3000,
      proxy: {
        '/api': { target: backend, changeOrigin: true, secure: false },
        '/ws': { target: backend.replace('https://', 'wss://'), ws: true, changeOrigin: true, secure: false }
      }
    },
    build: {
      outDir: 'dist',
      sourcemap: false
    }
  };
});
