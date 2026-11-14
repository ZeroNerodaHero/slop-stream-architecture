/**
 * The face reader's wasm for a classic worker, which is what a build makes of
 * `face.worker.ts` (vite's `worker.format` is `iife`): the loader is a script for
 * `importScripts`. Its own module so only one of the two 11 mb binaries is in a build
 * (`face.ts` picks this one or `face-wasm.module.ts`).
 */
import binary from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url';
import loader from '@mediapipe/tasks-vision/vision_wasm_internal.js?url';

import type { FaceWasm } from '@/infra/face-wire';

const wasm: FaceWasm = { loader, binary, module: false };
export default wasm;
