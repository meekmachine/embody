// @ts-nocheck
import {
  EMBODY_CORE_ABI_VERSION as CORE_ABI_VERSION,
  HAIR_CONFIG_FIELDS as CORE_HAIR_CONFIG_FIELDS,
  HAIR_CONFIG_STRIDE as CORE_HAIR_CONFIG_STRIDE,
  HAIR_HEAD_STATE_FIELDS as CORE_HAIR_HEAD_STATE_FIELDS,
  HAIR_HEAD_STATE_STRIDE as CORE_HAIR_HEAD_STATE_STRIDE,
  HAIR_MORPH_OUTPUT_FIELDS as CORE_HAIR_MORPH_OUTPUT_FIELDS,
  HAIR_MORPH_OUTPUT_STRIDE as CORE_HAIR_MORPH_OUTPUT_STRIDE,
  HAIR_STATE_FIELDS as CORE_HAIR_STATE_FIELDS,
  HAIR_STATE_STRIDE as CORE_HAIR_STATE_STRIDE,
  PACKED_MORPH_FRAME_DELTA_FIELDS as CORE_PACKED_MORPH_FRAME_DELTA_FIELDS,
  PACKED_MORPH_FRAME_DELTA_STRIDE as CORE_PACKED_MORPH_FRAME_DELTA_STRIDE,
  TEMPLATE_SKELETON_FIT_TRANSFORM_FIELDS as CORE_TEMPLATE_SKELETON_FIT_TRANSFORM_FIELDS,
  TEMPLATE_SKELETON_FIT_TRANSFORM_STRIDE as CORE_TEMPLATE_SKELETON_FIT_TRANSFORM_STRIDE,
} from './core/contracts';

export const EMBODY_CORE_ABI_VERSION = CORE_ABI_VERSION;
export const PACKED_MORPH_FRAME_DELTA_STRIDE = CORE_PACKED_MORPH_FRAME_DELTA_STRIDE;
export const PACKED_MORPH_FRAME_DELTA_FIELDS = CORE_PACKED_MORPH_FRAME_DELTA_FIELDS;
export const HAIR_CONFIG_STRIDE = CORE_HAIR_CONFIG_STRIDE;
export const HAIR_CONFIG_FIELDS = CORE_HAIR_CONFIG_FIELDS;
export const HAIR_STATE_STRIDE = CORE_HAIR_STATE_STRIDE;
export const HAIR_STATE_FIELDS = CORE_HAIR_STATE_FIELDS;
export const HAIR_HEAD_STATE_STRIDE = CORE_HAIR_HEAD_STATE_STRIDE;
export const HAIR_HEAD_STATE_FIELDS = CORE_HAIR_HEAD_STATE_FIELDS;
export const HAIR_MORPH_OUTPUT_STRIDE = CORE_HAIR_MORPH_OUTPUT_STRIDE;
export const HAIR_MORPH_OUTPUT_FIELDS = CORE_HAIR_MORPH_OUTPUT_FIELDS;
export const TEMPLATE_SKELETON_FIT_TRANSFORM_STRIDE = CORE_TEMPLATE_SKELETON_FIT_TRANSFORM_STRIDE;
export const TEMPLATE_SKELETON_FIT_TRANSFORM_FIELDS = CORE_TEMPLATE_SKELETON_FIT_TRANSFORM_FIELDS;

const WASM_MODULE_SPECIFIER = './wasm/embody_wasm.js';
const WASM_BINARY_SPECIFIER = './wasm/embody_wasm_bg.wasm';

/** @type {Promise<import('./wasmTypes').EmbodyCoreWasmModule> | null} */
let corePromise = null;

/** @returns {Promise<import('./wasmTypes').EmbodyCoreWasmModule>} */
export async function initEmbodyCore() {
  if (!corePromise) {
    corePromise = loadCoreModule();
  }
  return corePromise;
}

/** @returns {Promise<import('./wasmTypes').EmbodyCoreWasmModule>} */
export async function getEmbodyCore() {
  return initEmbodyCore();
}

export function resetEmbodyCoreForTests() {
  corePromise = null;
}

/** @returns {Promise<import('./wasmTypes').EmbodyCoreWasmModule>} */
async function loadCoreModule() {
  const mod = await importGeneratedWasmModule();
  if (typeof mod.default === 'function') {
    await mod.default({ module_or_path: await resolveWasmInitInput() });
  }

  assertCoreAbi(mod);
  return mod;
}

/** @returns {Promise<import('./wasmTypes').EmbodyCoreWasmModule>} */
async function importGeneratedWasmModule() {
  const dynamicImport = /** @type {(specifier: string) => Promise<import('./wasmTypes').EmbodyCoreWasmModule>} */ (
    new Function('specifier', 'return import(specifier)')
  );

  try {
    return await dynamicImport(resolveWasmModuleSpecifier());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Unable to load Embody Wasm core from generated package artifacts. Run "npm run build" before using @lovelace_lol/embody/wasm. Cause: ${message}`
    );
  }
}

function resolveWasmModuleSpecifier() {
  if (typeof import.meta.url === 'string' && import.meta.url.length > 0) {
    return new URL(WASM_MODULE_SPECIFIER, import.meta.url).href;
  }
  return WASM_MODULE_SPECIFIER;
}

/** @returns {Promise<unknown | undefined>} */
async function resolveWasmInitInput() {
  if (!isNodeLikeRuntime()) {
    return undefined;
  }

  const binaryUrl = resolveWasmBinarySpecifier();
  if (!binaryUrl.startsWith('file:')) {
    return undefined;
  }

  const dynamicImport = /** @type {(specifier: string) => Promise<any>} */ (
    new Function('specifier', 'return import(specifier)')
  );
  const [{ readFile }, { fileURLToPath }] = await Promise.all([
    dynamicImport('node:fs/promises'),
    dynamicImport('node:url'),
  ]);

  return readFile(fileURLToPath(binaryUrl));
}

function resolveWasmBinarySpecifier() {
  if (typeof import.meta.url === 'string' && import.meta.url.length > 0) {
    return new URL(WASM_BINARY_SPECIFIER, import.meta.url).href;
  }
  return WASM_BINARY_SPECIFIER;
}

function isNodeLikeRuntime() {
  const runtime = /** @type {{ process?: { versions?: { node?: string } } }} */ (globalThis);
  return Boolean(runtime.process?.versions?.node);
}

/** @param {import('./wasmTypes').EmbodyCoreWasmModule} mod */
function assertCoreAbi(mod) {
  const version = mod.core_abi_version();
  if (version !== EMBODY_CORE_ABI_VERSION) {
    throw new Error(`Unsupported Embody Wasm ABI version ${version}; expected ${EMBODY_CORE_ABI_VERSION}.`);
  }

  const checks = [
    ['packed morph frame delta', mod.packed_morph_frame_delta_stride(), PACKED_MORPH_FRAME_DELTA_STRIDE],
    ['hair config', mod.hair_config_stride(), HAIR_CONFIG_STRIDE],
    ['hair state', mod.hair_state_stride(), HAIR_STATE_STRIDE],
    ['hair head state', mod.hair_head_state_stride(), HAIR_HEAD_STATE_STRIDE],
    ['hair morph output', mod.hair_morph_output_stride(), HAIR_MORPH_OUTPUT_STRIDE],
    ['template skeleton fit transform', mod.template_skeleton_fit_transform_stride(), TEMPLATE_SKELETON_FIT_TRANSFORM_STRIDE],
  ];

  for (const [name, actual, expected] of checks) {
    if (actual !== expected) {
      throw new Error(`Unsupported Embody Wasm ${name} stride ${actual}; expected ${expected}.`);
    }
  }
}
