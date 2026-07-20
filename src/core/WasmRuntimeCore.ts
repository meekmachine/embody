import type {
  BoneDescriptor,
  BoneFrameDelta,
  BoneId,
  FrameDelta,
  MeshId,
  ModelDescriptor,
  MorphTargetDescriptor,
  MorphTargetFrameDelta,
  MorphTargetId,
} from './contracts';
import {
  PACKED_BONE_FLAG_HAS_POSITION,
  PACKED_BONE_FLAG_HAS_ROTATION,
  PACKED_BONE_FRAME_DELTA_STRIDE,
  PACKED_MORPH_FRAME_DELTA_STRIDE,
} from './contracts';
import type { BoneBinding, RotationAxis } from './types';
import { toAUList } from './compositeAxis';
import type { MorphTargetRef, Profile } from '../mappings/types';
import {
  getMeshNamesForAUProfile,
  getMeshNamesForVisemeProfile,
  getProfileVisemeSlots,
  getVisemeBindingTargets,
  getVisemeJawAmounts,
} from '../mappings/visemeSystem';
import type { EmbodyCoreWasmModule, WasmRuntimeCoreHandle } from '../wasmTypes';

export const AU_MORPH_BINDING_STRIDE = 5;
export const VISEME_MORPH_BINDING_STRIDE = 4;

export type MorphBindingSide = 0 | 1 | 2;

const AXIS_GROUP_NEGATIVE = 0;
const AXIS_GROUP_POSITIVE = 1;
const AXIS_GROUP_PLAIN = 2;

const BONE_SIDE_NONE = 0;
const BONE_SIDE_LEFT = 1;
const BONE_SIDE_RIGHT = 2;

const ROTATION_CHANNELS = { rx: 0, ry: 1, rz: 2 } as const;
const TRANSLATION_CHANNELS = { tx: 0, ty: 1, tz: 2 } as const;

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
    const { auBindings, mixedAus, visemeBindings } = compileMorphBindings(this.profile, this.model);
    this.core.load_au_morph_bindings(auBindings);
    this.core.load_viseme_morph_bindings(visemeBindings);
    this.core.set_mixed_aus(mixedAus);

    const boneBindings = compileBoneBindings(this.profile, this.model);
    this.core.load_bone_rest_transforms(boneBindings.restTransforms);
    this.core.load_composite_axes(boneBindings.compositeAxes);
    this.core.load_bone_translations(boneBindings.translations);
    this.core.load_jaw_binding(boneBindings.jawBinding);
    this.core.load_viseme_jaw_amounts(boneBindings.visemeJawAmounts);
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

export interface CompiledBoneBindings {
  restTransforms: Float32Array;
  compositeAxes: Float32Array;
  translations: Float32Array;
  jawBinding: Float32Array;
  visemeJawAmounts: Float32Array;
}

/**
 * Compile profile bone mappings into the packed tables the Rust RuntimeCore
 * consumes: rest transforms, composite rotation axes (in yaw/pitch/roll
 * application order), AU translations, and the auto viseme jaw binding.
 * Mirrors the mapping resolution in TsRuntimeCore.collectBoneWrites.
 */
export function compileBoneBindings(profile: Profile, model: ModelDescriptor): CompiledBoneBindings {
  const referencedBones = new Map<BoneId, BoneDescriptor>();
  const findBone = (nodeKey: string): BoneDescriptor | undefined => {
    const bone = findBoneDescriptor(profile, model, nodeKey);
    if (bone) referencedBones.set(bone.id, bone);
    return bone;
  };

  const boneSideForAU = (auId: number, nodeKey: string): number => {
    const side = profile.auToBones?.[auId]?.find((candidate) => candidate.node === nodeKey)?.side;
    if (side === 'left') return BONE_SIDE_LEFT;
    if (side === 'right') return BONE_SIDE_RIGHT;
    return BONE_SIDE_NONE;
  };

  const compositeRows: number[] = [];
  for (const composite of profile.compositeRotations || []) {
    const bone = findBone(composite.node);
    if (!bone) continue;

    // Application order must match TsRuntimeCore: yaw, pitch, roll.
    const axes: Array<{ axis: number; config: RotationAxis | null }> = [
      { axis: 1, config: composite.yaw },
      { axis: 0, config: composite.pitch },
      { axis: 2, config: composite.roll },
    ];

    for (const { axis, config } of axes) {
      if (!config) continue;

      const negativeAUs = toAUList(config.negative);
      const positiveAUs = toAUList(config.positive);
      const hasDirectional = negativeAUs.length > 0 && positiveAUs.length > 0;

      const valueRows: number[][] = [];
      if (hasDirectional) {
        for (const auId of negativeAUs) {
          valueRows.push([auId, AXIS_GROUP_NEGATIVE, boneSideForAU(auId, composite.node)]);
        }
        for (const auId of positiveAUs) {
          valueRows.push([auId, AXIS_GROUP_POSITIVE, boneSideForAU(auId, composite.node)]);
        }
      } else {
        for (const auId of config.aus) {
          valueRows.push([auId, AXIS_GROUP_PLAIN, boneSideForAU(auId, composite.node)]);
        }
      }

      const bindingRows: number[][] = [];
      const pushBindingRows = (auIds: number[], group: number) => {
        for (const auId of auIds) {
          const binding = profile.auToBones?.[auId]?.find(
            (candidate) => candidate.node === composite.node
          );
          if (!binding?.maxDegrees) continue;
          const channel = ROTATION_CHANNELS[binding.channel as keyof typeof ROTATION_CHANNELS];
          if (channel === undefined) continue;
          bindingRows.push([
            auId,
            group,
            boneSideForAU(auId, composite.node),
            channel,
            binding.scale,
            binding.maxDegrees,
          ]);
        }
      };
      pushBindingRows(negativeAUs, AXIS_GROUP_NEGATIVE);
      pushBindingRows(positiveAUs, AXIS_GROUP_POSITIVE);
      pushBindingRows(config.aus, AXIS_GROUP_PLAIN);

      compositeRows.push(
        Number(bone.id),
        axis,
        hasDirectional ? 1 : 0,
        valueRows.length,
        bindingRows.length,
        0,
        0,
        0
      );
      for (const row of valueRows) compositeRows.push(...row);
      for (const row of bindingRows) compositeRows.push(...row);
    }
  }

  const translationRows: number[] = [];
  for (const [auIdText, bindings] of Object.entries(profile.auToBones || {})) {
    const auId = Number(auIdText);
    if (Number.isNaN(auId)) continue;
    for (const binding of bindings || []) {
      const channel = TRANSLATION_CHANNELS[binding.channel as keyof typeof TRANSLATION_CHANNELS];
      if (channel === undefined || binding.maxUnits === undefined) continue;
      const bone = findBone(binding.node);
      if (!bone) continue;
      translationRows.push(auId, Number(bone.id), channel, binding.scale, binding.maxUnits);
    }
  }

  const jawRow: number[] = [];
  const jawBinding = findAutoVisemeJawBinding(profile, model);
  if (jawBinding?.maxDegrees) {
    const bone = findBone(jawBinding.node);
    const channel = ROTATION_CHANNELS[jawBinding.channel as keyof typeof ROTATION_CHANNELS];
    if (bone && channel !== undefined) {
      jawRow.push(Number(bone.id), channel, jawBinding.scale, jawBinding.maxDegrees);
    }
  }

  const restRows: number[] = [];
  for (const bone of referencedBones.values()) {
    const position = bone.restTransform?.position;
    const rotation = bone.restTransform?.rotation;
    restRows.push(
      Number(bone.id),
      position?.x ?? 0,
      position?.y ?? 0,
      position?.z ?? 0,
      rotation?.x ?? 0,
      rotation?.y ?? 0,
      rotation?.z ?? 0,
      rotation?.w ?? 1
    );
  }

  return {
    restTransforms: Float32Array.from(restRows),
    compositeAxes: Float32Array.from(compositeRows),
    translations: Float32Array.from(translationRows),
    jawBinding: Float32Array.from(jawRow),
    visemeJawAmounts: Float32Array.from(getVisemeJawAmounts(profile) ?? []),
  };
}

function findBoneDescriptor(
  profile: Profile,
  model: ModelDescriptor,
  nodeKey: string
): BoneDescriptor | undefined {
  const configuredName = profile.boneNodes?.[nodeKey] || nodeKey;
  const prefix = profile.bonePrefix ?? '';
  const suffix = profile.boneSuffix ?? '';
  const prefixedName = prefix && !configuredName.startsWith(prefix)
    ? `${prefix}${configuredName}`
    : configuredName;
  const fullName = suffix && !prefixedName.endsWith(suffix)
    ? `${prefixedName}${suffix}`
    : prefixedName;
  const candidates = new Set([nodeKey, configuredName, fullName]);
  return model.bones.find((bone) => candidates.has(bone.name));
}

function findAutoVisemeJawBinding(
  profile: Profile,
  model: ModelDescriptor
): (BoneBinding & { channel: 'rx' | 'ry' | 'rz' }) | null {
  const isRotation = (
    binding: BoneBinding | undefined
  ): binding is BoneBinding & { channel: 'rx' | 'ry' | 'rz' } =>
    binding?.channel === 'rx' || binding?.channel === 'ry' || binding?.channel === 'rz';

  const candidates = [
    profile.auToBones?.[103]?.find(isRotation),
    profile.auToBones?.[26]?.find(isRotation),
  ].filter((binding): binding is BoneBinding & { channel: 'rx' | 'ry' | 'rz' } => !!binding);

  return candidates.find((binding) => !!findBoneDescriptor(profile, model, binding.node))
    ?? candidates[0]
    ?? null;
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
