import react from '@vitejs/plugin-react';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv, type Plugin } from 'vite';

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
      res.end(readFileSync(file, 'utf8').replace('</head>', '<script type="module" src="/@vite/client"></script></head>'));
    });

    server.watcher.add(dir);
    server.watcher.on('all', (_event, changed) => {
      if (!changed.startsWith(dir + sep)) return;
      const hit = changed.endsWith('.html') ? [relative(dir, changed)] : pages();
      for (const page of hit) server.hot.send({ type: 'full-reload', path: `/tech-docs/${page}` });
    });
  }
});

const remixIcons = (): Plugin => {
  const prefix = 'remixicon:';
  const barrel = /import\s*\{([^}]*)\}\s*from\s*['"]@remixicon\/react['"];?/g;
  let icons: Map<string, string> | null = null;
  const iconSource = (name: string) => {
    if (!icons) {
      const file = fileURLToPath(new URL('./node_modules/@remixicon/react/index.mjs', import.meta.url));
      const source = readFileSync(file, 'utf8');
      const react = /^\s*(?:\/\*[\s\S]*?\*\/\s*)?import\s+(\w+)\s+from\s*"react";/.exec(source);
      const tail = source.lastIndexOf('export{');
      if (!react || tail < 0) throw new Error('@remixicon/react changed shape: no react import or export list');
      const starts = [...source.matchAll(/(?<=[\s,;])([\w$]+)=\(\{color:C="currentColor"/g)].map((m) => ({ local: m[1]!, at: m.index }));
      const bodies = new Map<string, string>();
      starts.forEach((start, i) => {
        const end = i + 1 < starts.length ? starts[i + 1]!.at - 1 : source.lastIndexOf(';', tail);
        bodies.set(start.local, source.slice(start.at, end).replace(/^[\w$]+=/, ''));
      });
      icons = new Map();
      for (const pair of source.slice(tail + 'export{'.length, source.lastIndexOf('}')).split(',')) {
        const [local, exported] = pair.split(' as ').map((s) => s.trim());
        const body = local && bodies.get(local);
        if (exported && body) icons.set(exported, `import ${react[1]} from "react";\nconst icon=${body};\nexport default icon;\n`);
      }
    }
    const code = icons.get(name);
    if (!code) throw new Error(`no remix icon named ${name}`);
    return code;
  };
  return {
    name: 'remix-icons-per-module',
    enforce: 'pre',
    resolveId(id) {
      return id.startsWith(prefix) ? `\0${id}` : null;
    },
    load(id) {
      return id.startsWith(`\0${prefix}`) ? iconSource(id.slice(prefix.length + 1)) : null;
    },
    transform(code, id) {
      if (id.includes('node_modules') || !/\.[jt]sx?$/.test(id.split('?')[0]!) || !code.includes('@remixicon/react')) return null;
      const next = code.replace(barrel, (_whole, names: string) =>
        names
          .split(',')
          .map((part) => part.trim())
          .filter((part) => part && !part.startsWith('type '))
          .map((part) => {
            const [imported, local] = part.split(/\s+as\s+/);
            return `import ${local ?? imported} from '${prefix}${imported}';`;
          })
          .join('\n')
      );
      return next === code ? null : { code: next, map: null };
    }
  };
};

const preloadFirstPage = (pages: { path: string; module: string }[]): Plugin => {
  let base = '/';
  return {
    name: 'preload-first-page',
    apply: 'build',
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        const bundle = ctx.bundle;
        if (!bundle) return;
        const chunks = Object.values(bundle).filter((out) => out.type === 'chunk');
        const files = (module: string) => {
          const start = chunks.find((chunk) => chunk.facadeModuleId?.endsWith(module));
          if (!start) throw new Error(`no chunk for ${module}`);
          const seen = new Set<string>();
          const walk = (fileName: string) => {
            const chunk = chunks.find((c) => c.fileName === fileName);
            if (!chunk || chunk.isEntry || seen.has(fileName)) return;
            seen.add(fileName);
            chunk.imports.forEach(walk);
          };
          walk(start.fileName);
          return [...seen].map((file) => base + file);
        };
        const routes = pages.map((page) => [page.path, files(page.module)]);
        const code =
          `(function(){var r=${JSON.stringify(routes)},p=location.pathname;` +
          `for(var i=0;i<r.length;i++)if(new RegExp(r[i][0]).test(p)){r[i][1].forEach(function(h){` +
          `var l=document.createElement('link');l.rel='modulepreload';l.crossOrigin='';l.href=h;document.head.appendChild(l)});break}})()`;
        return [{ tag: 'script', children: code, injectTo: 'head' }];
      }
    }
  };
};

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
    plugins: [
      remixIcons(),
      react(),
      preloadFirstPage([
        { path: '^/$', module: '/src/app/home/HomePage.tsx' },
        { path: '^/watch/[^/]+/?$', module: '/src/app/watch/WatchPage.tsx' }
      ]),
      showDocs && techDocs(docsDir)
    ],
    define: {
      __BUILD__: JSON.stringify(process.env.BUILD || 'dev')
    },
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) }
    },
    server: {
      port: 42069,
      proxy: {
        '/api': { target: backend, changeOrigin: true, secure: false, configure: explain },
        '/thumb': { target: backend, changeOrigin: true, secure: false, configure: explain },
        '/ws': { target: backend.replace(/^http/, 'ws'), ws: true, changeOrigin: true, secure: false, configure: explain },
        '/chat': { target: backend.replace(/^http/, 'ws'), ws: true, changeOrigin: true, secure: false, configure: explain },
        '/events': { target: backend.replace(/^http/, 'ws'), ws: true, changeOrigin: true, secure: false, configure: explain },
        '^/voice$': { target: backend.replace(/^http/, 'ws'), ws: true, changeOrigin: true, secure: false, configure: explain }
      }
    },
    build: {
      outDir: 'dist',
      sourcemap: 'hidden'
    }
  };
});
