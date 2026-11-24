import binary from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url';
import loader from '@mediapipe/tasks-vision/vision_wasm_internal.js?url';

import type { FaceWasm } from '@/infra/face-wire';

const wasm: FaceWasm = { loader, binary, module: false };
export default wasm;
