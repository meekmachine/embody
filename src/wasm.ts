// @ts-nocheck
import {
  ANNOTATION_CAMERA_FRAMING_FIELDS as CORE_ANNOTATION_CAMERA_FRAMING_FIELDS,
  ANNOTATION_CAMERA_FRAMING_STRIDE as CORE_ANNOTATION_CAMERA_FRAMING_STRIDE,
  CAMERA_FLIGHT_SAMPLE_FIELDS as CORE_CAMERA_FLIGHT_SAMPLE_FIELDS,
  CAMERA_FLIGHT_SAMPLE_STRIDE as CORE_CAMERA_FLIGHT_SAMPLE_STRIDE,
  EMBODY_CORE_ABI_VERSION as CORE_ABI_VERSION,
  HAIR_CONFIG_FIELDS as CORE_HAIR_CONFIG_FIELDS,
  HAIR_CONFIG_STRIDE as CORE_HAIR_CONFIG_STRIDE,
  HAIR_HEAD_STATE_FIELDS as CORE_HAIR_HEAD_STATE_FIELDS,
  HAIR_HEAD_STATE_STRIDE as CORE_HAIR_HEAD_STATE_STRIDE,
  HAIR_MORPH_OUTPUT_FIELDS as CORE_HAIR_MORPH_OUTPUT_FIELDS,
  HAIR_MORPH_OUTPUT_STRIDE as CORE_HAIR_MORPH_OUTPUT_STRIDE,
  HAIR_STATE_FIELDS as CORE_HAIR_STATE_FIELDS,
  HAIR_STATE_STRIDE as CORE_HAIR_STATE_STRIDE,
  MARKER_VISIBILITY_FACTORS_FIELDS as CORE_MARKER_VISIBILITY_FACTORS_FIELDS,
  MARKER_VISIBILITY_FACTORS_STRIDE as CORE_MARKER_VISIBILITY_FACTORS_STRIDE,
  MARKER_ENDPOINT_FIELDS as CORE_MARKER_ENDPOINT_FIELDS,
  MARKER_ENDPOINT_STRIDE as CORE_MARKER_ENDPOINT_STRIDE,
  MESH_PROPORTIONS_FIELDS as CORE_MESH_PROPORTIONS_FIELDS,
  MESH_PROPORTIONS_STRIDE as CORE_MESH_PROPORTIONS_STRIDE,
  PACKED_MORPH_FRAME_DELTA_FIELDS as CORE_PACKED_MORPH_FRAME_DELTA_FIELDS,
  PACKED_MORPH_FRAME_DELTA_STRIDE as CORE_PACKED_MORPH_FRAME_DELTA_STRIDE,
  PACKED_BONE_FRAME_DELTA_FIELDS as CORE_PACKED_BONE_FRAME_DELTA_FIELDS,
  PACKED_BONE_FRAME_DELTA_STRIDE as CORE_PACKED_BONE_FRAME_DELTA_STRIDE,
  TEMPLATE_SKELETON_FIT_SOLUTION_FIELDS as CORE_TEMPLATE_SKELETON_FIT_SOLUTION_FIELDS,
  TEMPLATE_SKELETON_FIT_SOLUTION_STRIDE as CORE_TEMPLATE_SKELETON_FIT_SOLUTION_STRIDE,
  TEMPLATE_SKELETON_FIT_TRANSFORM_FIELDS as CORE_TEMPLATE_SKELETON_FIT_TRANSFORM_FIELDS,
  TEMPLATE_SKELETON_FIT_TRANSFORM_STRIDE as CORE_TEMPLATE_SKELETON_FIT_TRANSFORM_STRIDE,
} from './core/contracts';

export const EMBODY_CORE_ABI_VERSION = CORE_ABI_VERSION;
export const PACKED_MORPH_FRAME_DELTA_STRIDE = CORE_PACKED_MORPH_FRAME_DELTA_STRIDE;
export const PACKED_MORPH_FRAME_DELTA_FIELDS = CORE_PACKED_MORPH_FRAME_DELTA_FIELDS;
export const PACKED_BONE_FRAME_DELTA_STRIDE = CORE_PACKED_BONE_FRAME_DELTA_STRIDE;
export const PACKED_BONE_FRAME_DELTA_FIELDS = CORE_PACKED_BONE_FRAME_DELTA_FIELDS;
export const HAIR_CONFIG_STRIDE = CORE_HAIR_CONFIG_STRIDE;
export const HAIR_CONFIG_FIELDS = CORE_HAIR_CONFIG_FIELDS;
export const HAIR_STATE_STRIDE = CORE_HAIR_STATE_STRIDE;
export const HAIR_STATE_FIELDS = CORE_HAIR_STATE_FIELDS;
export const HAIR_HEAD_STATE_STRIDE = CORE_HAIR_HEAD_STATE_STRIDE;
export const HAIR_HEAD_STATE_FIELDS = CORE_HAIR_HEAD_STATE_FIELDS;
export const HAIR_MORPH_OUTPUT_STRIDE = CORE_HAIR_MORPH_OUTPUT_STRIDE;
export const HAIR_MORPH_OUTPUT_FIELDS = CORE_HAIR_MORPH_OUTPUT_FIELDS;
export const MESH_PROPORTIONS_STRIDE = CORE_MESH_PROPORTIONS_STRIDE;
export const MESH_PROPORTIONS_FIELDS = CORE_MESH_PROPORTIONS_FIELDS;
export const TEMPLATE_SKELETON_FIT_SOLUTION_STRIDE = CORE_TEMPLATE_SKELETON_FIT_SOLUTION_STRIDE;
export const TEMPLATE_SKELETON_FIT_SOLUTION_FIELDS = CORE_TEMPLATE_SKELETON_FIT_SOLUTION_FIELDS;
export const TEMPLATE_SKELETON_FIT_TRANSFORM_STRIDE = CORE_TEMPLATE_SKELETON_FIT_TRANSFORM_STRIDE;
export const TEMPLATE_SKELETON_FIT_TRANSFORM_FIELDS = CORE_TEMPLATE_SKELETON_FIT_TRANSFORM_FIELDS;
export const ANNOTATION_CAMERA_FRAMING_STRIDE = CORE_ANNOTATION_CAMERA_FRAMING_STRIDE;
export const ANNOTATION_CAMERA_FRAMING_FIELDS = CORE_ANNOTATION_CAMERA_FRAMING_FIELDS;
export const CAMERA_FLIGHT_SAMPLE_STRIDE = CORE_CAMERA_FLIGHT_SAMPLE_STRIDE;
export const CAMERA_FLIGHT_SAMPLE_FIELDS = CORE_CAMERA_FLIGHT_SAMPLE_FIELDS;
export const MARKER_VISIBILITY_FACTORS_STRIDE = CORE_MARKER_VISIBILITY_FACTORS_STRIDE;
export const MARKER_VISIBILITY_FACTORS_FIELDS = CORE_MARKER_VISIBILITY_FACTORS_FIELDS;
export const MARKER_ENDPOINT_STRIDE = CORE_MARKER_ENDPOINT_STRIDE;
export const MARKER_ENDPOINT_FIELDS = CORE_MARKER_ENDPOINT_FIELDS;

const WASM_MODULE_SPECIFIER = './wasm/embody_wasm.js';
const WASM_BINARY_SPECIFIER = './wasm/embody_wasm_bg.wasm';

/**
 * Process-wide Wasm singleton.
 *
 * Bundlers / Vite can still evaluate `wasm.ts` more than once (main package vs
 * `/wasm` entry, CJS vs ESM, HMR). Module-local `let` caches then diverge:
 * Polymer awaits `initEmbodyCore()` on one copy while sync helpers read
 * `getEmbodyCoreSync()` on another → intermittent "not initialized" failures
 * that abort character load and revert the UI.
 */
const EMBODY_WASM_CORE_GLOBAL_KEY = Symbol.for('@lovelace_lol/embody/wasm-core');

/**
 * @typedef {{
 *   corePromise: Promise<import('./wasmTypes').EmbodyCoreWasmModule> | null,
 *   cachedCore: import('./wasmTypes').EmbodyCoreWasmModule | null,
 * }} EmbodyWasmCoreCache
 */

/** @returns {EmbodyWasmCoreCache} */
function getSharedCoreCache() {
  const runtime = /** @type {Record<PropertyKey, EmbodyWasmCoreCache | undefined>} */ (globalThis);
  let cache = runtime[EMBODY_WASM_CORE_GLOBAL_KEY];
  if (!cache) {
    cache = { corePromise: null, cachedCore: null };
    runtime[EMBODY_WASM_CORE_GLOBAL_KEY] = cache;
  }
  return cache;
}

/** @returns {Promise<import('./wasmTypes').EmbodyCoreWasmModule>} */
export async function initEmbodyCore() {
  const cache = getSharedCoreCache();
  if (!cache.corePromise) {
    cache.corePromise = loadCoreModule().catch((error) => {
      // Allow a later retry after a transient load failure.
      const shared = getSharedCoreCache();
      if (shared.corePromise) {
        shared.corePromise = null;
      }
      shared.cachedCore = null;
      throw error;
    });
  }
  return cache.corePromise;
}

/** @returns {Promise<import('./wasmTypes').EmbodyCoreWasmModule>} */
export async function getEmbodyCore() {
  return initEmbodyCore();
}

/**
 * Synchronous access to the already-initialized Wasm module.
 * Call `await initEmbodyCore()` first (vitest setup does this).
 * @returns {import('./wasmTypes').EmbodyCoreWasmModule}
 */
export function getEmbodyCoreSync() {
  const { cachedCore } = getSharedCoreCache();
  if (!cachedCore) {
    throw new Error(
      'Embody Wasm core is not initialized. Await initEmbodyCore() before calling sync engine helpers.'
    );
  }
  return cachedCore;
}

export function resetEmbodyCoreForTests() {
  const cache = getSharedCoreCache();
  cache.corePromise = null;
  cache.cachedCore = null;
}

/**
 * Install a pre-loaded Wasm module into the sync cache (used by vitest setup
 * when the package dynamic import cannot resolve dist/wasm from source).
 * @param {import('./wasmTypes').EmbodyCoreWasmModule} mod
 */
export function setEmbodyCoreForTests(mod) {
  assertCoreAbi(mod);
  const cache = getSharedCoreCache();
  cache.cachedCore = mod;
  cache.corePromise = Promise.resolve(mod);
}

/** @returns {Promise<import('./wasmTypes').EmbodyCoreWasmModule>} */
async function loadCoreModule() {
  const mod = await importGeneratedWasmModule();
  if (typeof mod.default === 'function') {
    await mod.default({ module_or_path: await resolveWasmInitInput() });
  }

  assertCoreAbi(mod);
  getSharedCoreCache().cachedCore = mod;
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
    ['packed bone frame delta', mod.packed_bone_frame_delta_stride(), PACKED_BONE_FRAME_DELTA_STRIDE],
    ['hair config', mod.hair_config_stride(), HAIR_CONFIG_STRIDE],
    ['hair state', mod.hair_state_stride(), HAIR_STATE_STRIDE],
    ['hair head state', mod.hair_head_state_stride(), HAIR_HEAD_STATE_STRIDE],
    ['hair morph output', mod.hair_morph_output_stride(), HAIR_MORPH_OUTPUT_STRIDE],
    ['mesh proportions', mod.mesh_proportions_stride(), MESH_PROPORTIONS_STRIDE],
    ['template skeleton fit solution', mod.template_skeleton_fit_solution_stride(), TEMPLATE_SKELETON_FIT_SOLUTION_STRIDE],
    ['template skeleton fit transform', mod.template_skeleton_fit_transform_stride(), TEMPLATE_SKELETON_FIT_TRANSFORM_STRIDE],
    ['annotation camera framing', mod.annotation_camera_framing_stride(), ANNOTATION_CAMERA_FRAMING_STRIDE],
    ['camera flight sample', mod.camera_flight_sample_stride(), CAMERA_FLIGHT_SAMPLE_STRIDE],
    ['marker visibility factors', mod.marker_visibility_factors_stride(), MARKER_VISIBILITY_FACTORS_STRIDE],
    ['marker endpoint', mod.marker_endpoint_stride(), MARKER_ENDPOINT_STRIDE],
  ];

  for (const [name, actual, expected] of checks) {
    if (actual !== expected) {
      throw new Error(`Unsupported Embody Wasm ${name} stride ${actual}; expected ${expected}.`);
    }
  }
}
