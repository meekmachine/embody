import type {
  FrameDelta,
  MeshId,
  ModelDescriptor,
  MorphTargetDescriptor,
  MorphTargetFrameDelta,
  MorphTargetId,
} from './contracts';
import {
  PACKED_MORPH_FRAME_DELTA_STRIDE,
} from './contracts';
import type { MorphTargetRef, Profile } from '../mappings/types';
import {
  getMeshNamesForAUProfile,
  getMeshNamesForVisemeProfile,
  getProfileVisemeSlots,
  getVisemeBindingTargets,
} from '../mappings/visemeSystem';
import type { EmbodyCoreWasmModule, WasmRuntimeCoreHandle } from '../wasmTypes';

export const AU_MORPH_BINDING_STRIDE = 5;
export const VISEME_MORPH_BINDING_STRIDE = 4;

export type MorphBindingSide = 0 | 1 | 2;

export interface WasmRuntimeCoreOptions {
  readonly profile: Profile;
  readonly model: ModelDescriptor;
  readonly wasm: EmbodyCoreWasmModule;
}

/**
 * TypeScript facade over the Rust Wasm RuntimeCore for live morph FrameDelta
 * evaluation. Bones/composites remain on TsRuntimeCore until a later slice.
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
    this.core = new RuntimeCtor(getProfileVisemeSlots(options.profile).length);
    this.reloadBindings();
  }

  setProfile(profile: Profile): void {
    this.profile = profile;
    this.core.set_viseme_slot_count(getProfileVisemeSlots(profile).length);
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

  setViseme(visemeIndex: number, value: number): void {
    this.core.set_viseme(visemeIndex >>> 0, value);
  }

  clear(): void {
    this.core.clear();
  }

  evaluatePackedMorphFrameDelta(): Float32Array {
    return this.core.evaluate_morph_frame_delta();
  }

  evaluateMorphFrameDelta(deltaSeconds?: number): FrameDelta {
    return {
      deltaSeconds,
      morphTargets: unpackMorphFrameDelta(this.evaluatePackedMorphFrameDelta()),
    };
  }

  private reloadBindings(): void {
    const { auBindings, mixedAus, visemeBindings } = compileMorphBindings(this.profile, this.model);
    this.core.load_au_morph_bindings(auBindings);
    this.core.load_viseme_morph_bindings(visemeBindings);
    this.core.set_mixed_aus(mixedAus);
  }
}

export function compileMorphBindings(
  profile: Profile,
  model: ModelDescriptor
): {
  auBindings: Float32Array;
  visemeBindings: Float32Array;
  mixedAus: Uint32Array;
} {
  const auRows: number[] = [];
  const mixed: number[] = [];

  for (const [auIdText, entry] of Object.entries(profile.auToMorphs || {})) {
    const auId = Number(auIdText);
    if (Number.isNaN(auId) || !entry) continue;

    const meshNames = getMeshNamesForAUProfile(profile, auId);
    const hasMorphs = !!(entry.left?.length || entry.right?.length || entry.center?.length);
    if (hasMorphs && profile.auToBones?.[auId]?.length) {
      mixed.push(auId);
    }

    pushAuSide(auRows, auId, 0, entry.left || [], meshNames, model, profile);
    pushAuSide(auRows, auId, 1, entry.right || [], meshNames, model, profile);
    pushAuSide(auRows, auId, 2, entry.center || [], meshNames, model, profile);
  }

  const visemeRows: number[] = [];
  const visemeMeshNames = getMeshNamesForVisemeProfile(profile);
  const slotCount = getProfileVisemeSlots(profile).length;
  for (let index = 0; index < slotCount; index += 1) {
    for (const bindingTarget of getVisemeBindingTargets(profile, index)) {
      for (const resolved of resolveMorphTargets(model, profile, bindingTarget.morph, visemeMeshNames)) {
        visemeRows.push(
          index,
          Number(resolved.mesh.id),
          Number(resolved.morphTarget.id),
          bindingTarget.weight
        );
      }
    }
  }

  return {
    auBindings: Float32Array.from(auRows),
    visemeBindings: Float32Array.from(visemeRows),
    mixedAus: Uint32Array.from(mixed),
  };
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

function pushAuSide(
  rows: number[],
  auId: number,
  side: MorphBindingSide,
  morphs: readonly MorphTargetRef[],
  meshNames: string[],
  model: ModelDescriptor,
  profile: Profile
): void {
  for (const morph of morphs) {
    for (const resolved of resolveMorphTargets(model, profile, morph, meshNames)) {
      rows.push(
        auId,
        side,
        Number(resolved.mesh.id),
        Number(resolved.morphTarget.id),
        1
      );
    }
  }
}

function resolveMorphTargets(
  model: ModelDescriptor,
  profile: Profile,
  morph: MorphTargetRef,
  meshNames: string[]
): Array<{ mesh: ModelDescriptor['meshes'][number]; morphTarget: MorphTargetDescriptor }> {
  const result: Array<{ mesh: ModelDescriptor['meshes'][number]; morphTarget: MorphTargetDescriptor }> = [];
  for (const meshName of meshNames) {
    const mesh = model.meshes.find((candidate) => candidate.name === meshName);
    if (!mesh) continue;
    const morphTargets = mesh.morphTargetIds
      .map((id) => model.morphTargets.find((candidate) => candidate.id === id))
      .filter((target): target is MorphTargetDescriptor => !!target);

    const target = typeof morph === 'number'
      ? morphTargets.find((candidate) => candidate.hostIndex === morph)
      : resolveMorphTargetByName(morphTargets, morph, profile);
    if (target) {
      result.push({ mesh, morphTarget: target });
    }
  }
  return result;
}

function resolveMorphTargetByName(
  targets: readonly MorphTargetDescriptor[],
  key: string,
  profile: Profile
): MorphTargetDescriptor | undefined {
  const prefix = profile.morphPrefix || '';
  const suffix = profile.morphSuffix || '';
  const fullName = prefix + key + suffix;
  const exact = targets.find((target) => target.name === fullName);
  if (exact) return exact;

  const suffixRegex = profile.suffixPattern ? new RegExp(profile.suffixPattern) : null;
  if (!suffixRegex) return undefined;

  return targets.find((target) => {
    if (!target.name.startsWith(fullName)) return false;
    const candidateSuffix = target.name.slice(fullName.length);
    return candidateSuffix === '' || suffixRegex.test(candidateSuffix);
  });
}
