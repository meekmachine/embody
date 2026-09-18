// This fixture is copied into an isolated consumer of the packed package.
// The error assertions below fail if the public loader regresses to `any`.
import { initEmbodyCore as initFromRoot } from '@lovelace_lol/embody';
import {
  getEmbodyCore,
  initEmbodyCore,
  requireInitializedEmbodyCore,
  type EmbodyCore,
  type RuntimeCore,
} from '@lovelace_lol/embody/wasm';

const core: EmbodyCore = await initEmbodyCore();
const runtime: RuntimeCore = new core.RuntimeCore(15);
runtime.configure_with_preset('cc4', '{}', '{}');
runtime.set_au(12, 0.5, 0);
runtime.load_au_morph_bindings(new Float32Array([12, 2, 0, 0, 1]));
runtime.set_mixed_aus(new Uint32Array([12]));
const value: number = runtime.get_au(12);
const frame: Float32Array = runtime.evaluate_active_morph_frame();
const clip: string = runtime.build_clip('smile', '{}', '{}');
const removed: boolean = runtime.remove_animation_clip('smile');
runtime.free();

const result: Float32Array = core.solve_bilateral_values(1, 0);
const presets: string[] = core.list_presets();
const profile: string = core.resolve_profile_view('{}');
const solver = new core.HairPhysicsSolver(core.default_hair_physics_config_values());
const hairFrame: Float32Array = solver.update(0.016, new Float32Array(5));
solver.free();

// Inferred types matter as well as explicitly annotated consumers.
const inferred = await initEmbodyCore();
const inferredRuntime = new inferred.RuntimeCore(0);
// @ts-expect-error Unknown Wasm module exports must be rejected.
inferred.missing_export();
// @ts-expect-error Runtime methods must come from wasm-bindgen declarations.
inferredRuntime.missing_method();
// @ts-expect-error AU ids are numeric.
inferredRuntime.set_au('12', 0.5, 0);
// @ts-expect-error All required arguments remain required.
inferredRuntime.set_au(12, 0.5);
// @ts-expect-error Packed Rust f32 slices require Float32Array.
inferredRuntime.load_au_morph_bindings([12, 2, 0, 0, 1]);
// @ts-expect-error Return values must retain their generated types.
const wrongFrame: string = inferredRuntime.evaluate_morph_frame_delta();
// @ts-expect-error Constructors retain numeric argument types.
new inferred.RuntimeCore('15');
// @ts-expect-error Helpers retain their argument types.
inferred.solve_bilateral_values('1', 0);
// @ts-expect-error Helpers retain their return types.
const wrongResult: number = inferred.solve_bilateral_values(1, 0);

// Every public route to the module must preserve the generated shape.
const rootCore = await initFromRoot();
const aliasCore = await getEmbodyCore();
const initializedCore = requireInitializedEmbodyCore();
// @ts-expect-error The root entrypoint must not widen the loader return type.
rootCore.missing_export();
// @ts-expect-error The async alias must not widen the loader return type.
aliasCore.missing_export();
// @ts-expect-error The synchronous accessor must not widen the loader return type.
initializedCore.missing_export();
