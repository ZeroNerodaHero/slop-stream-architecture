import binary from '@mediapipe/tasks-vision/vision_wasm_module_internal.wasm?url';
import loader from '@mediapipe/tasks-vision/vision_wasm_module_internal.js?url';

import type { FaceWasm } from '@/infra/face-wire';

const wasm: FaceWasm = { loader, binary, module: true };
export default wasm;
