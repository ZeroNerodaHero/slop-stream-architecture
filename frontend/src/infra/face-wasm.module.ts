/**
 * The face reader's wasm for a module worker, which is what the dev server makes of
 * `face.worker.ts`: `importScripts` throws there, and the reader falls back to `import()`,
 * which wants the es module loader. See `face-wasm.classic.ts`.
 */
import binary from '@mediapipe/tasks-vision/vision_wasm_module_internal.wasm?url';
import loader from '@mediapipe/tasks-vision/vision_wasm_module_internal.js?url';

import type { FaceWasm } from '@/infra/face-wire';

const wasm: FaceWasm = { loader, binary, module: true };
export default wasm;
