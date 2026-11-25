import react from '@vitejs/plugin-react';
import autoprefixer from 'autoprefixer';
import { transform as minifyCss } from 'lightningcss';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import { defineConfig, loadEnv, type Plugin, type ResolvedConfig } from 'vite';

import tailwindConfig from './tailwind.config';

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

const cssTargets = (target: ResolvedConfig['build']['cssTarget']) => {
  const browsers: Record<string, string> = { chrome: 'chrome', edge: 'edge', firefox: 'firefox', safari: 'safari', ios: 'ios_saf', opera: 'opera' };
  const targets: Record<string, number> = {};
  for (const entry of target ? [target].flat() : []) {
    const match = /^([a-z]+)(\d+)(?:\.(\d+))?$/.exec(entry);
    const browser = match?.[1] && browsers[match[1]];
    if (!match || !browser) continue;
    const version = (Number(match[2]) << 16) | (Number(match[3] ?? 0) << 8);
    if (!targets[browser] || version < targets[browser]) targets[browser] = version;
  }
  return Object.keys(targets).length > 0 ? targets : undefined;
};

const deferStylesheet = (stylesheet: string, path: string): Plugin => {
  let config: ResolvedConfig;
  return {
    name: 'defer-stylesheet',
    apply: 'build',
    configResolved(resolved) {
      config = resolved;
    },
    transformIndexHtml: {
      order: 'post',
      async handler(html, ctx) {
        const bundle = ctx.bundle;
        if (!bundle) return;
        const link = /\s*<link rel="stylesheet" crossorigin href="([^"]+\.css)">/.exec(html);
        if (!link) throw new Error('index.html has no stylesheet link');
        const href = link[1] ?? '';
        const full = bundle[href.slice(config.base.length)];
        if (!full || full.type !== 'asset') throw new Error(`no asset for ${href}`);
        const source = readFileSync(stylesheet, 'utf8').replace(/^@(import|tailwind utilities)\b[^;]*;\s*/gm, '');
        const result = await postcss([
          tailwindcss({ ...tailwindConfig, content: [{ raw: '<body class="bg-background font-sans text-textPrimary antialiased">', extension: 'html' }] }),
          autoprefixer()
        ]).process(source, {
          from: stylesheet
        });
        const shell = new TextDecoder().decode(
          minifyCss({ filename: 'shell.css', code: Buffer.from(result.css), minify: true, targets: cssTargets(config.build.cssTarget) }).code
        );
        if (/<\/style/i.test(shell)) throw new Error('shell css closes its style tag');
        config.logger.info(
          `  shell css: ${(shell.length / 1000).toFixed(2)} kB inlined, ${(full.source.length / 1000).toFixed(2)} kB stylesheet off the critical path on ${path}`
        );
        const loader =
          `(function(){var h=${JSON.stringify(href)};if(new RegExp(${JSON.stringify(path)}).test(location.pathname)){` +
          `var l=document.createElement('link');l.rel='stylesheet';l.crossOrigin='';l.href=h;` +
          `window.__bootCss=new Promise(function(r){l.onload=l.onerror=r});document.head.appendChild(l)}` +
          `else document.write('<link rel="stylesheet" crossorigin href="'+h+'">')})()`;
        return html.replace(link[0], '').replace('</head>', `  <style>${shell}</style>\n    <script>${loader}</script>\n  </head>`);
      }
    }
  };
};

const versionFile = (build: string): Plugin => ({
  name: 'version-file',
  apply: 'build',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'version.json', source: `${JSON.stringify({ build })}\n` });
  }
});

export default defineConfig(({ mode }) => {
  const build = process.env.BUILD || 'dev';
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
      deferStylesheet(join(here, 'src', 'app', 'globals.css'), '^/$'),
      versionFile(build),
      showDocs && techDocs(docsDir)
    ],
    define: {
      __BUILD__: JSON.stringify(build)
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
        '^/rt(/|$)': { target: backend.replace(/^http/, 'ws'), ws: true, changeOrigin: true, secure: false, configure: explain },
        '^/voice$': { target: backend.replace(/^http/, 'ws'), ws: true, changeOrigin: true, secure: false, configure: explain }
      }
    },
    build: {
      outDir: 'dist',
      sourcemap: 'hidden'
    }
  };
});
