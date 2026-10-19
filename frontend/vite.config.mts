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

  // A dead backend would be a bare 502. Say what is wrong and how to fix it instead.
  const explain = (proxy: { on: (event: 'error', handler: (err: Error, req: unknown, res: unknown) => void) => void }) => {
    proxy.on('error', (err, _req, res) => {
      const message =
        `backend ${backend} did not answer (${err.message}).\n\n` +
        `  the server:      BACKEND=https://<server ip> npm run dev   (or put it in frontend/.env)\n` +
        `  this machine:    ./deploy.sh in the repo root, then npm run dev\n`;
      console.error(`\n  ${message}`);
      const r = res as { headersSent?: boolean; writeHead?: (code: number, headers: Record<string, string>) => void; end?: (body: string) => void };
      if (r && typeof r.writeHead === 'function' && !r.headersSent) {
        r.writeHead(502, { 'content-type': 'text/plain' });
        r.end?.(message);
      }
    });
  };

  return {
    plugins: [react()],
    define: {
      // the commit the pages were built from. deploy.sh sets BUILD; `npm run dev` is "dev".
      // every error report (src/infra/report.ts) carries it.
      __BUILD__: JSON.stringify(process.env.BUILD || 'dev')
    },
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) }
    },
    server: {
      // an odd port on purpose: 3000 is usually taken by something else
      port: 42069,
      proxy: {
        '/api': { target: backend, changeOrigin: true, secure: false, configure: explain },
        '/thumb': { target: backend, changeOrigin: true, secure: false, configure: explain },
        '/ws': { target: backend.replace(/^http/, 'ws'), ws: true, changeOrigin: true, secure: false, configure: explain },
        '/chat': { target: backend.replace(/^http/, 'ws'), ws: true, changeOrigin: true, secure: false, configure: explain }
      }
    },
    build: {
      outDir: 'dist',
      // maps next to the assets (served like the rest of /assets, the source is public anyway),
      // without a sourceMappingURL comment. a minified stack in an error report maps back by hand.
      sourcemap: 'hidden'
    }
  };
});
