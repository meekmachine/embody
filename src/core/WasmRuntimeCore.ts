import type {
  BoneFrameDelta,
  BoneId,
  FrameDelta,
  MeshId,
  ModelDescriptor,
  MorphTargetFrameDelta,
  MorphTargetId,
} from './contracts';
import {
  PACKED_BONE_FLAG_HAS_POSITION,
  PACKED_BONE_FLAG_HAS_ROTATION,
  PACKED_BONE_FRAME_DELTA_STRIDE,
  PACKED_MORPH_FRAME_DELTA_STRIDE,
} from './contracts';
import type { Profile } from '../mappings/types';
import type { EmbodyCoreWasmModule, WasmRuntimeCoreHandle } from '../wasmTypes';

export interface WasmRuntimeCoreOptions {
  readonly profile: Profile;
  readonly model: ModelDescriptor;
  readonly wasm: EmbodyCoreWasmModule;
}

/**
 * TypeScript facade over the host-neutral Rust Wasm RuntimeCore.
 * JavaScript only owns JSON handoff and packed FrameDelta unpacking here.
 */
export class WasmRuntimeCore {
  private readonly wasm: EmbodyCoreWasmModule;
  private readonly core: WasmRuntimeCoreHandle;
  private profile: Profile;
  private model: ModelDescriptor;

  constructor(options: WasmRuntimeCoreOptions) {
    this.wasm = options.wasm;
    this.profile = options.profile;
    this.model = options.model;
    const RuntimeCtor = options.wasm.RuntimeCore;
    if (!RuntimeCtor) {
      throw new Error('Embody Wasm module does not export RuntimeCore');
    }
    this.core = new RuntimeCtor(0);
    this.reloadBindings();
  }

  setProfile(profile: Profile): void {
    this.profile = profile;
    this.reloadBindings();
  }

  setModelDescriptor(model: ModelDescriptor): void {
    this.model = model;
    this.reloadBindings();
  }

  setAU(id: number, value: number, balance = 0): void {
    this.core.set_au(id >>> 0, value, balance);
  }

  getAU(id: number): number {
    return this.core.get_au(id >>> 0);
  }

  setAUMixWeight(id: number, weight: number): void {
    this.core.set_au_mix_weight(id >>> 0, weight);
  }

  setViseme(visemeIndex: number, value: number, jawScale?: number): void {
    this.core.set_viseme(visemeIndex >>> 0, value);
    if (jawScale !== undefined) {
      this.core.set_viseme_jaw_scale(visemeIndex >>> 0, jawScale);
    }
  }

  clear(): void {
    this.core.clear();
  }

  evaluatePackedMorphFrameDelta(): Float32Array {
    return this.core.evaluate_morph_frame_delta();
  }

  evaluatePackedBoneFrameDelta(): Float32Array {
    return this.core.evaluate_bone_frame_delta();
  }

  evaluateMorphFrameDelta(deltaSeconds?: number): FrameDelta {
    return {
      deltaSeconds,
      morphTargets: unpackMorphFrameDelta(this.evaluatePackedMorphFrameDelta()),
    };
  }

  evaluateFrameDelta(deltaSeconds?: number): FrameDelta {
    return {
      deltaSeconds,
      morphTargets: unpackMorphFrameDelta(this.evaluatePackedMorphFrameDelta()),
      bones: unpackBoneFrameDelta(this.evaluatePackedBoneFrameDelta()),
    };
  }

  private reloadBindings(): void {
    this.core.configure_with_profile(JSON.stringify(this.profile), JSON.stringify(this.model));
  }
}

export function unpackBoneFrameDelta(values: ArrayLike<number>): BoneFrameDelta[] {
  const stride = PACKED_BONE_FRAME_DELTA_STRIDE;
  const writes: BoneFrameDelta[] = [];
  for (let index = 0; index + stride <= values.length; index += stride) {
    const flags = values[index + 8] ?? 0;
    const hasPosition = (flags & PACKED_BONE_FLAG_HAS_POSITION) !== 0;
    const hasRotation = (flags & PACKED_BONE_FLAG_HAS_ROTATION) !== 0;
    if (!hasPosition && !hasRotation) continue;
    writes.push({
      boneId: values[index] as BoneId,
      transform: {
        ...(hasPosition
          ? { position: { x: values[index + 1], y: values[index + 2], z: values[index + 3] } }
          : {}),
        ...(hasRotation
          ? {
              rotation: {
                x: values[index + 4],
                y: values[index + 5],
                z: values[index + 6],
                w: values[index + 7],
              },
            }
          : {}),
      },
      mode: 'absolute',
      space: 'local',
    });
  }
  return writes;
}

export function unpackMorphFrameDelta(values: ArrayLike<number>): MorphTargetFrameDelta[] {
  const stride = PACKED_MORPH_FRAME_DELTA_STRIDE;
  const writes: MorphTargetFrameDelta[] = [];
  for (let index = 0; index + stride <= values.length; index += stride) {
    writes.push({
      meshId: values[index] as MeshId,
      morphTargetId: values[index + 1] as MorphTargetId,
      value: values[index + 2] ?? 0,
      mode: (values[index + 3] ?? 0) === 1 ? 'additive' : 'absolute',
    });
  }
  return writes;
}
