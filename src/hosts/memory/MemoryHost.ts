import type { ModelDescriptor } from '../../core/contracts';
import {
  PACKED_BONE_FRAME_DELTA_STRIDE,
  PACKED_MORPH_FRAME_DELTA_STRIDE,
} from '../../core/contracts';
import type { Profile } from '../../mappings/types';
import type { EmbodyCoreWasmModule, WasmRuntimeCoreHandle } from '../../wasmTypes';
import { initEmbodyCore, requireInitializedEmbodyCore } from '../../wasm';
import type { EmbodyHostControls } from '../types';

export interface MemoryHostConfig {
  /** Embedded Wasm preset id (cc4, fish, aliases). Default: cc4. */
  presetId?: string;
  /** Optional profile overrides merged onto the embedded preset. */
  profile?: Profile | Record<string, unknown>;
  wasm?: EmbodyCoreWasmModule;
}

export interface MemoryBonePose {
  px: number;
  py: number;
  pz: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  flags: number;
}

/**
 * Engine-agnostic host: proves RuntimeCore + packed ABI without Three.js.
 * Morph/bone results land in plain Maps for tests and future adapters.
 */
export class MemoryHost implements EmbodyHostControls {
  private core: WasmRuntimeCoreHandle;
  private wasm: EmbodyCoreWasmModule;
  private descriptor: ModelDescriptor;
  private presetId: string;
  private overrideJson: string;
  private disposed = false;

  /** morphTargetId → influence */
  readonly morphValues = new Map<number, number>();
  /** boneId → pose */
  readonly bonePoses = new Map<number, MemoryBonePose>();

  private constructor(
    wasm: EmbodyCoreWasmModule,
    core: WasmRuntimeCoreHandle,
    descriptor: ModelDescriptor,
    presetId: string,
    overrideJson: string,
  ) {
    this.wasm = wasm;
    this.core = core;
    this.descriptor = descriptor;
    this.presetId = presetId;
    this.overrideJson = overrideJson;
  }

  static async create(
    descriptor: ModelDescriptor,
    config: MemoryHostConfig = {},
  ): Promise<MemoryHost> {
    const wasm = config.wasm ?? await initEmbodyCore();
    return MemoryHost.createWithWasm(wasm, descriptor, config);
  }

  /** Sync create when Wasm is already initialized. */
  static createSync(
    descriptor: ModelDescriptor,
    config: MemoryHostConfig = {},
  ): MemoryHost {
    const wasm = config.wasm ?? requireInitializedEmbodyCore();
    return MemoryHost.createWithWasm(wasm, descriptor, config);
  }

  private static createWithWasm(
    wasm: EmbodyCoreWasmModule,
    descriptor: ModelDescriptor,
    config: MemoryHostConfig,
  ): MemoryHost {
    const presetId = resolvePresetId(config.presetId);
    const overrideJson = config.profile ? JSON.stringify(config.profile) : '';
    const host = new MemoryHost(
      wasm,
      new wasm.RuntimeCore(0),
      descriptor,
      presetId,
      overrideJson,
    );
    host.configure();
    return host;
  }

  private configure(): void {
    this.core.configure_with_preset(
      this.presetId,
      this.overrideJson,
      JSON.stringify(this.descriptor),
    );
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

  update(dtSeconds: number): void {
    const dt = Math.max(0, dtSeconds || 0);
    if (dt <= 0) return;
    const activeBefore = this.core.active_transition_count();
    const activeAfter = this.core.update(dt);
    if (activeBefore > 0 || activeAfter > 0) {
      this.applyFrame();
    }
  }

  activeTransitionCount(): number {
    return this.core.active_transition_count();
  }

  clear(): void {
    this.core.clear();
    this.morphValues.clear();
    this.bonePoses.clear();
    this.applyFrame();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.core.free?.();
  }

  /** Merged profile JSON from the Wasm embedded preset (for assertions). */
  mergedProfileJson(): string {
    return this.wasm.merge_embedded_preset(this.presetId, this.overrideJson);
  }

  private applyFrame(): void {
    const morphs = this.core.evaluate_morph_frame_delta();
    const morphStride = PACKED_MORPH_FRAME_DELTA_STRIDE;
    for (let i = 0; i + morphStride <= morphs.length; i += morphStride) {
      const morphTargetId = morphs[i + 1]!;
      const value = morphs[i + 2]!;
      const mode = morphs[i + 3] ?? 0;
      if (mode === 1) {
        this.morphValues.set(morphTargetId, (this.morphValues.get(morphTargetId) ?? 0) + value);
      } else {
        this.morphValues.set(morphTargetId, value);
      }
    }

    const bones = this.core.evaluate_bone_frame_delta();
    const boneStride = PACKED_BONE_FRAME_DELTA_STRIDE;
    for (let i = 0; i + boneStride <= bones.length; i += boneStride) {
      const boneId = bones[i]!;
      this.bonePoses.set(boneId, {
        px: bones[i + 1]!,
        py: bones[i + 2]!,
        pz: bones[i + 3]!,
        qx: bones[i + 4]!,
        qy: bones[i + 5]!,
        qz: bones[i + 6]!,
        qw: bones[i + 7]!,
        flags: bones[i + 8]!,
      });
    }
  }
}

function resolvePresetId(presetId: string | undefined): string {
  const id = (presetId ?? 'cc4').trim().toLowerCase();
  if (id === 'fish' || id === 'skeletal') return 'fish';
  return 'cc4';
}
