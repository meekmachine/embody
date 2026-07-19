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

export interface WasmHairPhysicsSolver {
  update(dtSeconds: number, headValues: Float32Array): Float32Array;
  set_config(configValues: Float32Array): void;
  get_config(): Float32Array;
  get_state(): Float32Array;
  reset(): void;
  free?: () => void;
}

export interface WasmHairPhysicsSolverConstructor {
  new(configValues: Float32Array): WasmHairPhysicsSolver;
}

export interface EmbodyCoreWasmModule {
  default?: (moduleOrPath?: unknown) => Promise<unknown> | unknown;
  core_abi_version(): number;
  packed_morph_frame_delta_stride(): number;
  pack_morph_frame_delta(
    meshIds: Uint32Array,
    morphTargetIds: Uint32Array,
    values: Float32Array,
    modes: Uint8Array
  ): Float32Array;
  solve_bilateral_values(base: number, balance: number): Float32Array;
  solve_morph_batch(values: Float32Array, balances: Float32Array, mixWeights: Float32Array): Float32Array;
  solve_axis_quaternion(axis: number, degrees: number, value: number, scale: number): Float32Array;
  hair_config_stride(): number;
  hair_state_stride(): number;
  hair_head_state_stride(): number;
  hair_morph_output_stride(): number;
  template_skeleton_fit_transform_stride(): number;
  compose_template_skeleton_fit_transform(
    fitScale: number,
    fitTranslation: Float32Array,
    manualScale: number,
    manualTranslation: Float32Array
  ): Float32Array;
  default_hair_physics_config_values(): Float32Array;
  HairPhysicsSolver: WasmHairPhysicsSolverConstructor;
}

const WASM_MODULE_SPECIFIER = './wasm/embody_wasm.js';
const WASM_BINARY_SPECIFIER = './wasm/embody_wasm_bg.wasm';

let corePromise: Promise<EmbodyCoreWasmModule> | null = null;

export async function initEmbodyCore(): Promise<EmbodyCoreWasmModule> {
  if (!corePromise) {
    corePromise = loadCoreModule();
  }
  return corePromise;
}

export async function getEmbodyCore(): Promise<EmbodyCoreWasmModule> {
  return initEmbodyCore();
}

export function resetEmbodyCoreForTests(): void {
  corePromise = null;
}

async function loadCoreModule(): Promise<EmbodyCoreWasmModule> {
  const mod = await importGeneratedWasmModule();
  if (typeof mod.default === 'function') {
    await mod.default({ module_or_path: await resolveWasmInitInput() });
  }

  assertCoreAbi(mod);
  return mod;
}

async function importGeneratedWasmModule(): Promise<EmbodyCoreWasmModule> {
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (
    specifier: string
  ) => Promise<EmbodyCoreWasmModule>;

  try {
    return await dynamicImport(resolveWasmModuleSpecifier());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Unable to load Embody Wasm core from generated package artifacts. Run "npm run build" before using @lovelace_lol/embody/wasm. Cause: ${message}`
    );
  }
}

function resolveWasmModuleSpecifier(): string {
  if (typeof import.meta.url === 'string' && import.meta.url.length > 0) {
    return new URL(WASM_MODULE_SPECIFIER, import.meta.url).href;
  }
  return WASM_MODULE_SPECIFIER;
}

async function resolveWasmInitInput(): Promise<unknown | undefined> {
  if (!isNodeLikeRuntime()) {
    return undefined;
  }

  const binaryUrl = resolveWasmBinarySpecifier();
  if (!binaryUrl.startsWith('file:')) {
    return undefined;
  }

  const dynamicImport = new Function('specifier', 'return import(specifier)') as <T>(specifier: string) => Promise<T>;
  const [{ readFile }, { fileURLToPath }] = await Promise.all([
    dynamicImport<{ readFile(path: string): Promise<Uint8Array> }>('node:fs/promises'),
    dynamicImport<{ fileURLToPath(url: string): string }>('node:url'),
  ]);

  return readFile(fileURLToPath(binaryUrl));
}

function resolveWasmBinarySpecifier(): string {
  if (typeof import.meta.url === 'string' && import.meta.url.length > 0) {
    return new URL(WASM_BINARY_SPECIFIER, import.meta.url).href;
  }
  return WASM_BINARY_SPECIFIER;
}

function isNodeLikeRuntime(): boolean {
  return Boolean((globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node);
}

function assertCoreAbi(mod: EmbodyCoreWasmModule): void {
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
  ] as const;

  for (const [name, actual, expected] of checks) {
    if (actual !== expected) {
      throw new Error(`Unsupported Embody Wasm ${name} stride ${actual}; expected ${expected}.`);
    }
  }
}
