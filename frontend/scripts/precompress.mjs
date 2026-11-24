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
    if (br.length > raw.length * 0.95) return;
    writeFileSync(`${path}.br`, br);
    before += raw.length;
    after += br.length;
  })
);
console.log(`precompressed: ${files.length} assets, ${Math.round(before / 1024)} kB -> ${Math.round(after / 1024)} kB brotli`);
