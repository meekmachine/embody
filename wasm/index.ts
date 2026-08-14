import cc4Preset from '../assets/presets/cc4.json';
import cc4HumanoidSkeletonTemplate from '../assets/templates/cc4-humanoid.json';

export const EMBODY_CORE_ABI_VERSION = 1;
export const PACKED_MORPH_FRAME_DELTA_STRIDE = 4;
export const PACKED_BONE_FRAME_DELTA_STRIDE = 9;
export const HAIR_CONFIG_STRIDE = 11;
export const HAIR_STATE_STRIDE = 4;
export const HAIR_HEAD_STATE_STRIDE = 5;
export const HAIR_MORPH_OUTPUT_STRIDE = 6;
export const MESH_PROPORTIONS_STRIDE = 16;
export const TEMPLATE_SKELETON_FIT_SOLUTION_STRIDE = 10;
export const TEMPLATE_SKELETON_FIT_TRANSFORM_STRIDE = 4;
export const ANNOTATION_CAMERA_FRAMING_STRIDE = 7;
export const CAMERA_FLIGHT_SAMPLE_STRIDE = 7;
export const MARKER_VISIBILITY_FACTORS_STRIDE = 3;
export const MARKER_ENDPOINT_STRIDE = 3;
export const SCREEN_SPACE_GAZE_SOLUTION_STRIDE = 14;

// Synchronous compatibility data is bundled from the same JSON assets embedded
// by Rust. Hair color swatches and the CC4 humanoid skeleton live with the
// CC4 rig preset — not as character-specific side registries.
export const HAIR_COLOR_PRESETS = cc4Preset.hairColorPresets;
export const DEFAULT_HAIR_COLOR_APPEARANCE = HAIR_COLOR_PRESETS.natural_brown;
export const CC4_HUMANOID_SKELETON_TEMPLATE = cc4HumanoidSkeletonTemplate;
export const HUMANOID_SKELETON_TEMPLATES = [CC4_HUMANOID_SKELETON_TEMPLATE];

type Core = Record<string, any> & { default?: (input?: unknown) => Promise<unknown> };

let pending: Promise<Core> | null = null;
let loaded: Core | null = null;

export async function initEmbodyCore(): Promise<Core> {
  if (!pending) {
    pending = load().catch((error) => {
      pending = null;
      loaded = null;
      throw error;
    });
  }
  return pending;
}

export const getEmbodyCore = initEmbodyCore;

export function requireInitializedEmbodyCore(): Core {
  if (!loaded) throw new Error('Embody Wasm core is not initialized. Await initEmbodyCore() first.');
  return loaded;
}

export function resetEmbodyCoreForTests() {
  pending = null;
  loaded = null;
}

async function load(): Promise<Core> {
  // Keep these paths runtime-resolved so host bundlers can relocate the Wasm
  // siblings without eagerly converting the static URL expressions to assets.
  const resolveAsset = (path: string) => new URL(path, import.meta.url);
  const moduleUrl = resolveAsset('./wasm/embody_wasm.js').href;
  const binaryUrl = resolveAsset('./wasm/embody_wasm_bg.wasm');
  const core = await import(/* @vite-ignore */ moduleUrl) as Core;
  if (typeof core.default === 'function') {
    let input: unknown = binaryUrl;
    if ((globalThis as any).process?.versions?.node && binaryUrl.protocol === 'file:') {
      const fsSpecifier = 'node:fs/promises';
      const urlSpecifier = 'node:url';
      const [{ readFile }, { fileURLToPath }] = await Promise.all([
        import(/* @vite-ignore */ fsSpecifier),
        import(/* @vite-ignore */ urlSpecifier),
      ]);
      input = await readFile(fileURLToPath(binaryUrl));
    }
    await core.default({ module_or_path: input });
  }
  if (core.core_abi_version() !== EMBODY_CORE_ABI_VERSION) {
    throw new Error(`Unsupported Embody Wasm ABI version ${core.core_abi_version()}.`);
  }
  loaded = core;
  return core;
}
