import type { Mesh, Object3D } from 'three';
import type { Profile } from '../../mappings/types';
import type { PresetType } from '../../presets';
import type { EmbodyCoreWasmModule, WasmRuntimeCoreHandle } from '../../wasmTypes';
import { initEmbodyCore } from '../../wasm';
import { getPreset } from '../../presets';
import { CC4_PRESET } from '../../presets/cc4';
import { extendPresetWithProfile } from '../../mappings/extendPresetWithProfile';
import { ThreeModelInspector } from './ThreeModelInspector';
import { ThreeFrameApplier } from './ThreeFrameApplier';
import { buildFrameApplierBindings } from './Embody';

export interface RustEmbodyHostConfig {
  profile?: Profile;
  presetType?: PresetType;
  meshes?: Mesh[];
  /** Pre-initialized wasm module (used by tests and hosts with custom loaders). */
  wasm?: EmbodyCoreWasmModule;
}

/**
 * Thin Three.js host adapter over the Rust engine.
 *
 * All animation logic lives in the Rust RuntimeCore: profile/binding
 * compilation, AU/viseme/continuum state, transitions, and frame evaluation.
 * This class only does what JavaScript must do because Three.js objects live
 * in JavaScript:
 *  - read the model into a plain data descriptor (ThreeModelInspector)
 *  - forward control calls and the per-frame clock to the core
 *  - write the core's packed frame output back onto Three.js objects
 *    (ThreeFrameApplier)
 */
export class RustEmbodyHost {
  private core: WasmRuntimeCoreHandle;
  private model: Object3D;
  private profile: Profile;
  private inspector = new ThreeModelInspector();
  private applier = new ThreeFrameApplier();
  private disposed = false;

  private constructor(core: WasmRuntimeCoreHandle, model: Object3D, profile: Profile) {
    this.core = core;
    this.model = model;
    this.profile = profile;
  }

  static async create(model: Object3D, config: RustEmbodyHostConfig = {}): Promise<RustEmbodyHost> {
    const wasm = config.wasm ?? await initEmbodyCore();
    const basePreset = config.presetType ? getPreset(config.presetType) : CC4_PRESET;
    const profile = extendPresetWithProfile(basePreset, config.profile);
    const host = new RustEmbodyHost(new wasm.RuntimeCore(0), model, profile);
    host.bindModel(config.meshes);
    return host;
  }

  /** Re-inspect the model and reconfigure the core (e.g. after mesh changes). */
  bindModel(meshes?: Mesh[]): void {
    const inspection = this.inspector.inspectModel(this.model, {
      profile: this.profile,
      meshes,
    });
    this.applier.setBindings(buildFrameApplierBindings(inspection));
    this.core.configure(JSON.stringify(this.profile), JSON.stringify(inspection.descriptor));
    this.applyFrame();
  }

  setAU(id: number, value: number, balance?: number): void {
    this.core.set_au_signed(id, value, balance ?? Number.NaN);
    this.applyFrame();
  }

  getAU(id: number): number {
    return this.core.get_au(id);
  }

  setContinuum(negAU: number, posAU: number, value: number, balance?: number): void {
    this.core.set_continuum(negAU, posAU, value, balance ?? Number.NaN);
    this.applyFrame();
  }

  getContinuum(negAU: number, posAU: number): number {
    return this.core.get_continuum(negAU, posAU);
  }

  setViseme(index: number, value: number, jawScale = 1.0): void {
    this.core.set_viseme(index, value);
    this.core.set_viseme_jaw_scale(index, jawScale);
    this.applyFrame();
  }

  setVisemeById(slotId: string, value: number, jawScale = 1.0): void {
    const index = this.core.viseme_slot_index(slotId);
    if (index < 0) return;
    this.setViseme(index, value, jawScale);
  }

  setAUMixWeight(id: number, weight: number): void {
    this.core.set_au_mix_weight(id, weight);
    this.applyFrame();
  }

  transitionAU(id: number, to: number, durationMs = 200, balance?: number): void {
    this.core.transition_au(id, to, durationMs, balance ?? Number.NaN);
  }

  transitionViseme(index: number, to: number, durationMs = 80, jawScale = 1.0): void {
    this.core.transition_viseme(index, to, durationMs, jawScale);
  }

  transitionVisemeById(slotId: string, to: number, durationMs = 80, jawScale = 1.0): void {
    const index = this.core.viseme_slot_index(slotId);
    if (index < 0) return;
    this.transitionViseme(index, to, durationMs, jawScale);
  }

  /** Advance transitions and apply the resulting frame. Call once per render tick. */
  update(dtSeconds: number): void {
    const activeBefore = this.core.active_transition_count();
    const activeAfter = this.core.update(dtSeconds);
    if (activeBefore > 0 || activeAfter > 0) {
      this.applyFrame();
    }
  }

  activeTransitionCount(): number {
    return this.core.active_transition_count();
  }

  clear(): void {
    this.core.clear();
    this.applyFrame();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.core.free?.();
  }

  private applyFrame(): void {
    const morphs = this.core.evaluate_morph_frame_delta();
    if (morphs.length > 0) {
      this.applier.applyPackedMorphFrameDelta(morphs);
    }
    const bones = this.core.evaluate_bone_frame_delta();
    if (bones.length > 0) {
      this.applier.applyPackedBoneFrameDelta(bones);
      this.model.updateMatrixWorld(true);
    }
  }
}
