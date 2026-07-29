import { Clock, Object3D, type Mesh } from 'three';
import type { Profile, MeshInfo } from '../../mappings/types';
import type { PresetType } from '../../presets';
import type {
  AnimationClipInfo,
  ClipHandle,
  ClipOptions,
  CurvesMap,
  CompositeRotation,
} from '../../core/types';
import type { EmbodyCoreWasmModule, WasmRuntimeCoreHandle } from '../../wasmTypes';
import { initEmbodyCore, requireInitializedEmbodyCore } from '../../wasm';
import { CC4_MESHES } from '../../presets/cc4';
import { ThreeModelInspector } from '../../engines/three/ThreeModelInspector';
import { ThreeFrameApplier } from '../../engines/three/ThreeFrameApplier';
import { ThreeAnimationSystem } from '../../engines/three/ThreeAnimationRuntime';
import type { ResolvedBones } from '../../engines/three/types';
import { getSideScale } from '../../engines/three/balanceUtils';
import {
  getMeshNamesForAUProfile,
  getMeshNamesForVisemeProfile,
} from '../../mappings/visemeSystem';
import { buildFrameApplierBindings } from './frameBindings';
import type { EmbodyHostControls } from '../types';

export interface RustEmbodyHostConfig {
  profile?: Profile;
  presetType?: PresetType | string;
  meshes?: Mesh[];
  /** Pre-initialized wasm module (tests / custom loaders). */
  wasm?: EmbodyCoreWasmModule;
}

/**
 * Thin Three.js host over the Rust engine.
 *
 * Presets live inside Wasm. This host only:
 *  - inspects the Three.js model
 *  - calls `configure_with_preset`
 *  - forwards live controls to RuntimeCore
 *  - applies packed frame output to Three.js
 *  - delegates AnimationMixer / snippets to ThreeAnimationSystem (host-only)
 */
export class RustEmbodyHost implements EmbodyHostControls {
  private core: WasmRuntimeCoreHandle;
  private wasm: EmbodyCoreWasmModule;
  private model: Object3D | null;
  private profile: Profile;
  private presetId: string;
  private overrideJson = '';
  private meshes: Mesh[] = [];
  private meshByName = new Map<string, Mesh>();
  private bones: ResolvedBones = {};
  private inspector = new ThreeModelInspector();
  private applier = new ThreeFrameApplier();
  private animationController: ThreeAnimationSystem;
  private clock = new Clock();
  private isRunning = false;
  private animationFrameId: number | null = null;
  private disposed = false;
  private visemeValues: number[] = [];

  private constructor(
    wasm: EmbodyCoreWasmModule,
    core: WasmRuntimeCoreHandle,
    model: Object3D,
    profile: Profile,
    presetId: string,
  ) {
    this.wasm = wasm;
    this.core = core;
    this.model = model;
    this.profile = profile;
    this.presetId = presetId;
    this.animationController = new ThreeAnimationSystem({
      getModel: () => this.model,
      getMeshes: () => this.meshes,
      getMeshByName: (name) => this.meshByName.get(name),
      getMeshNamesForAU: (auId) => getMeshNamesForAUProfile(this.profile, auId),
      getMeshNamesForViseme: () => getMeshNamesForVisemeProfile(this.profile),
      getCurrentAUValue: (auId) => this.getAU(auId),
      getCurrentVisemeValue: (visemeIndex) => this.visemeValues[visemeIndex] ?? 0,
      getCurrentMorphValue: (morphKey, meshNames) => this.getMorphValueForMeshes(morphKey, meshNames),
      getCurrentBoneQuaternion: (nodeKey) => this.bones[nodeKey]?.obj.quaternion.clone() ?? null,
      getCurrentBonePositionValue: (nodeKey, axis) => this.bones[nodeKey]?.obj.position[axis] ?? null,
      getBones: () => this.bones,
      getConfig: () => this.profile,
      getCompositeRotations: () => (this.profile.compositeRotations ?? []) as CompositeRotation[],
      computeSideValues: (base, balance) => ({
        left: base * getSideScale(balance ?? 0, 'left'),
        right: base * getSideScale(balance ?? 0, 'right'),
      }),
      getAUMixWeight: () => 1,
      isMixedAU: (auId) => {
        const hasMorphs = !!(this.profile.auToMorphs?.[auId]);
        return hasMorphs && !!(this.profile.auToBones?.[auId]?.length);
      },
      reapplyProceduralState: () => this.applyFrame(),
    });
  }

  static async create(model: Object3D, config: RustEmbodyHostConfig = {}): Promise<RustEmbodyHost> {
    const wasm = config.wasm ?? await initEmbodyCore();
    return RustEmbodyHost.createWithWasm(wasm, model, config);
  }

  static createSync(model: Object3D, config: RustEmbodyHostConfig = {}): RustEmbodyHost {
    const wasm = config.wasm ?? requireInitializedEmbodyCore();
    return RustEmbodyHost.createWithWasm(wasm, model, config);
  }

  /**
   * Create without a model yet (LoomLarge constructs the engine, then onReady).
   * Requires Wasm already initialized.
   */
  static createUnbound(config: RustEmbodyHostConfig = {}): RustEmbodyHost {
    const wasm = config.wasm ?? requireInitializedEmbodyCore();
    return RustEmbodyHost.createWithWasm(wasm, null, config);
  }

  private static createWithWasm(
    wasm: EmbodyCoreWasmModule,
    model: Object3D | null,
    config: RustEmbodyHostConfig,
  ): RustEmbodyHost {
    const presetId = resolvePresetId(config.presetType);
    const overrideJson = config.profile ? JSON.stringify(config.profile) : '';
    const profile = JSON.parse(wasm.merge_embedded_preset(presetId, overrideJson)) as Profile;
    const host = new RustEmbodyHost(
      wasm,
      new wasm.RuntimeCore(0),
      model ?? new Object3D(),
      profile,
      presetId,
    );
    host.overrideJson = overrideJson;
    if (model) {
      host.onReady({ model, meshes: config.meshes });
    }
    return host;
  }

  onReady(options: { model: Object3D; meshes?: Mesh[] }): void {
    this.model = options.model;
    this.bindModel(options.meshes);
  }

  bindModel(meshes?: Mesh[]): void {
    if (!this.model) return;
    const inspection = this.inspector.inspectModel(this.model, {
      profile: this.profile,
      meshes,
    });
    this.meshes = inspection.allMeshes;
    this.meshByName = inspection.meshByName;
    this.bones = inspection.bones;
    this.applier.setBindings(buildFrameApplierBindings(inspection));
    this.core.configure_with_preset(
      this.presetId,
      this.overrideJson,
      JSON.stringify(inspection.descriptor),
    );
    this.applyFrame();
  }

  setProfile(profile: Profile): void {
    this.profile = profile;
    this.overrideJson = JSON.stringify(profile);
    this.presetId = 'cc4';
    if (this.model) {
      this.bindModel(this.meshes);
    }
  }

  getProfile(): Profile {
    return this.profile;
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
    if (index >= this.visemeValues.length) {
      this.visemeValues.length = index + 1;
    }
    this.visemeValues[index] = value;
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

  update(dtSeconds: number): void {
    const dt = Math.max(0, dtSeconds || 0);
    if (dt <= 0) return;
    const activeBefore = this.core.active_transition_count();
    const activeAfter = this.core.update(dt);
    if (activeBefore > 0 || activeAfter > 0) {
      this.applyFrame();
    }
    this.animationController.update(dt);
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.clock.start();
    const tick = () => {
      if (!this.isRunning) return;
      this.update(this.clock.getDelta());
      this.animationFrameId = requestAnimationFrame(tick);
    };
    this.animationFrameId = requestAnimationFrame(tick);
  }

  stop(): void {
    this.isRunning = false;
    this.clock.stop();
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  activeTransitionCount(): number {
    return this.core.active_transition_count();
  }

  clear(): void {
    this.core.clear();
    this.applyFrame();
  }

  getMeshList(): MeshInfo[] {
    if (!this.model) return [];
    const result: MeshInfo[] = [];
    this.model.traverse((obj: any) => {
      if (obj.isMesh) {
        const meshInfo = CC4_MESHES[obj.name];
        result.push({
          name: obj.name,
          visible: obj.visible,
          morphCount: obj.morphTargetInfluences?.length || 0,
          category: meshInfo?.category || 'other',
        });
      }
    });
    return result;
  }

  getMorphTargets(): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    for (const mesh of this.meshes) {
      const dict = mesh.morphTargetDictionary;
      if (!dict) continue;
      result[mesh.name] = Object.keys(dict);
    }
    return result;
  }

  getBones(): ResolvedBones {
    return this.bones;
  }

  loadAnimationClips(clips: unknown[]): void {
    this.animationController.loadAnimationClips(clips);
  }

  getAnimationClips(): AnimationClipInfo[] {
    return this.animationController.getAnimationClips();
  }

  playAnimation(clipName: string, options?: Parameters<ThreeAnimationSystem['playAnimation']>[1]) {
    return this.animationController.playAnimation(clipName, options);
  }

  stopAnimation(clipName: string): void {
    this.animationController.stopAnimation(clipName);
  }

  stopAllAnimations(): void {
    this.animationController.stopAllAnimations();
  }

  pauseAnimation(clipName: string): void {
    this.animationController.pauseAnimation(clipName);
  }

  resumeAnimation(clipName: string): void {
    this.animationController.resumeAnimation(clipName);
  }

  buildClip(clipName: string, curves: CurvesMap, options?: ClipOptions): ClipHandle | null {
    return this.animationController.buildClip(clipName, curves, options);
  }

  playTypedSnippet(
    snippet: Parameters<ThreeAnimationSystem['playTypedSnippet']>[0],
    options?: Parameters<ThreeAnimationSystem['playTypedSnippet']>[1],
  ) {
    return this.animationController.playTypedSnippet(snippet, options);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    this.animationController.dispose();
    this.core.free?.();
  }

  private getMorphValueForMeshes(morphKey: string, meshNames?: string[]): number {
    const names = meshNames?.length ? meshNames : this.meshes.map((m) => m.name);
    let max = 0;
    for (const name of names) {
      const mesh = this.meshByName.get(name);
      const dict = mesh?.morphTargetDictionary;
      const infl = mesh?.morphTargetInfluences;
      if (!dict || !infl) continue;
      const idx = dict[morphKey];
      if (idx === undefined) continue;
      max = Math.max(max, infl[idx] ?? 0);
    }
    return max;
  }

  private applyFrame(): void {
    const morphs = this.core.evaluate_morph_frame_delta();
    if (morphs.length > 0) {
      this.applier.applyPackedMorphFrameDelta(morphs);
    }
    const bones = this.core.evaluate_bone_frame_delta();
    if (bones.length > 0) {
      this.applier.applyPackedBoneFrameDelta(bones);
      this.model?.updateMatrixWorld(true);
    }
  }
}

function resolvePresetId(presetType: PresetType | string | undefined): string {
  switch (presetType) {
    case 'fish':
    case 'skeletal':
      return 'fish';
    case 'cc4':
    case 'custom':
    case undefined:
    default:
      return 'cc4';
  }
}

/** Convenience async factory matching Polymer createRustEmbodyHost. */
export function createRustEmbodyHost(
  model: Object3D,
  config?: RustEmbodyHostConfig,
): Promise<RustEmbodyHost> {
  return RustEmbodyHost.create(model, config);
}
