// Brotli at its best (quality 11) beside every built asset that shrinks, as `<file>.br`, after
// `vite build` (`npm run build`). caddy serves the .br to a browser that takes br (Caddyfile
// `precompressed br` on /assets) and compresses on the fly as before for the rest. on the fly is
// gzip or zstd at a fast level: the main bundle is ~23% bigger that way, and on a cold load it
// is downloaded in tcp slow start, so every 14kB is part of a round trip (docs/debugging.md
// "Watch startup timings"). index.html is left alone: publish-pages.sh renames it into place
// last, and a .br beside it could go in first and serve the new page early.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, constants } from 'node:zlib';

const dir = 'dist/assets';
const KINDS = /\.(js|mjs|css|wasm|svg|json)$/;
const compress = promisify(brotliCompress);

const files = readdirSync(dir).filter((f) => KINDS.test(f));
let before = 0;
let after = 0;
await Promise.all(
  files.map(async (f) => {
    const path = join(dir, f);
    const raw = readFileSync(path);
    const br = await compress(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: statSync(path).size } });
    // too small to be worth a second file
    if (br.length > raw.length * 0.95) return;
    writeFileSync(`${path}.br`, br);
    before += raw.length;
    after += br.length;
  })
);
console.log(`precompressed: ${files.length} assets, ${Math.round(before / 1024)} kB -> ${Math.round(after / 1024)} kB brotli`);
