import react from '@vitejs/plugin-react';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv, type Plugin } from 'vite';

// SHOW_DOCS=1 in the repo's .env (or the shell): the human docs, docs/tech-docs/*.html, at
// /tech-docs on this dev server. plain files, no build step: the tech-docs skill
// (.cursor/skills/tech-docs) writes them. a saved page reloads only the tabs showing that page
// (the vite client's full-reload matches on an .html path), so an app tab is never bounced by
// a docs edit. `npm run dev` only: caddy never serves these, and the docker build never sees them.
const techDocs = (dir: string): Plugin => ({
  name: 'tech-docs',
  configureServer(server) {
    const types: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.txt': 'text/plain; charset=utf-8'
    };
    const pages = () => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.html')) : []);

    server.middlewares.use('/tech-docs', (req, res, next) => {
      if (req.method !== 'GET') return next();
      // connect strips the mount path; the bare /tech-docs needs its slash so the pages' relative links hold
      if ((req.originalUrl || '').split('?')[0] === '/tech-docs') {
        res.writeHead(302, { location: '/tech-docs/' });
        return res.end();
      }
      const path = decodeURIComponent((req.url || '/').split('?')[0] || '/').replace(/\/$/, '/index.html');
      const file = normalize(join(dir, path));
      if (!file.startsWith(dir + sep) || !existsSync(file) || !statSync(file).isFile()) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end(`no such page: docs/tech-docs${path}\n\nthe pages:\n  ${pages().join('\n  ') || '(none yet: the tech-docs skill writes them)'}\n`);
      }
      res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      if (extname(file) !== '.html') return res.end(readFileSync(file));
      // the vite client, for the reload below. the pages themselves carry no script
      res.end(readFileSync(file, 'utf8').replace('</head>', '<script type="module" src="/@vite/client"></script></head>'));
    });

    // a page saved: that page's tabs reload. the stylesheet (or anything else) saved: every page's
    server.watcher.add(dir);
    server.watcher.on('all', (_event, changed) => {
      if (!changed.startsWith(dir + sep)) return;
      const hit = changed.endsWith('.html') ? [relative(dir, changed)] : pages();
      for (const page of hit) server.hot.send({ type: 'full-reload', path: `/tech-docs/${page}` });
    });
  }
});

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
  const showDocs = (process.env.SHOW_DOCS ?? repo.SHOW_DOCS) === '1';
  const docsDir = join(repoRoot, 'docs', 'tech-docs');
  console.log(showDocs ? `  tech docs: http://localhost:42069/tech-docs   (SHOW_DOCS=0 in ../.env to hide)` : `  tech docs: off   (SHOW_DOCS=1 in ../.env to serve docs/tech-docs at /tech-docs)`);

  // A dead backend would be a bare 502. Say what is wrong and how to fix it instead.
  const explain = (proxy: { on: (event: 'error', handler: (err: Error, req: unknown, res: unknown) => void) => void }) => {
    proxy.on('error', (err, _req, res) => {
      const message =
        `backend ${backend} did not answer (${err.message}).\n\n` +
        `  the server:      BACKEND=https://<server ip> npm run dev   (or put it in frontend/.env)\n` +
        `  this machine:    ./scripts/deploy.sh in the repo root, then npm run dev\n`;
      console.error(`\n  ${message}`);
      const r = res as { headersSent?: boolean; writeHead?: (code: number, headers: Record<string, string>) => void; end?: (body: string) => void };
      if (r && typeof r.writeHead === 'function' && !r.headersSent) {
        r.writeHead(502, { 'content-type': 'text/plain' });
        r.end?.(message);
      }
    });
  };

  return {
    plugins: [react(), showDocs && techDocs(docsDir)],
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
        '/chat': { target: backend.replace(/^http/, 'ws'), ws: true, changeOrigin: true, secure: false, configure: explain },
        '/events': { target: backend.replace(/^http/, 'ws'), ws: true, changeOrigin: true, secure: false, configure: explain }
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
