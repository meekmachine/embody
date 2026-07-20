import type {
  BoneFrameDelta,
  BoneDescriptor,
  BoneId,
  FrameDelta,
  MeshDescriptor,
  ModelDescriptor,
  MorphTargetDescriptor,
  MorphTargetId,
  Quat,
  Transform,
  Vec3,
} from './contracts';
import type { BoneBinding, BoneKey, CompositeRotation, RotationAxis } from './types';
import { getCompositeAxisBinding, getCompositeAxisValue } from './compositeAxis';
import type { MorphTargetRef, Profile } from '../mappings/types';
import {
  getMeshNamesForAUProfile,
  getMeshNamesForVisemeProfile,
  getProfileVisemeSlots,
  getVisemeBindingTargets,
  getVisemeJawAmounts,
  getVisemeSlotIndex,
} from '../mappings/visemeSystem';

export interface TsRuntimeCoreOptions {
  readonly profile: Profile;
  readonly model: ModelDescriptor;
}

type MorphTargetLookup = {
  readonly mesh: MeshDescriptor;
  readonly morphTarget: MorphTargetDescriptor;
};

type RotationState = Record<string, { pitch: number; yaw: number; roll: number }>;

const identityQuat: Quat = { x: 0, y: 0, z: 0, w: 1 };

function isRotationBoneBinding(binding: BoneBinding | undefined): binding is BoneBinding & { channel: 'rx' | 'ry' | 'rz' } {
  return binding?.channel === 'rx' || binding?.channel === 'ry' || binding?.channel === 'rz';
}

export class TsRuntimeCore {
  private profile: Profile;
  private model: ModelDescriptor;
  private auValues: Record<number, number> = {};
  private auBalances: Record<number, number> = {};
  private visemeValues: number[];
  private visemeJawScales: number[];
  private mixWeights: Record<number, number>;

  constructor(options: TsRuntimeCoreOptions) {
    this.profile = options.profile;
    this.model = options.model;
    this.visemeValues = new Array(getProfileVisemeSlots(this.profile).length).fill(0);
    this.visemeJawScales = new Array(this.visemeValues.length).fill(1);
    this.mixWeights = { ...this.profile.auMixDefaults };
  }

  setProfile(profile: Profile): void {
    this.profile = profile;
    this.visemeValues = new Array(getProfileVisemeSlots(this.profile).length).fill(0);
    this.visemeJawScales = new Array(this.visemeValues.length).fill(1);
    this.mixWeights = { ...this.profile.auMixDefaults };
  }

  setModelDescriptor(model: ModelDescriptor): void {
    this.model = model;
  }

  setAU(id: number, value: number, balance?: number): void {
    if (value < 0 && this.profile.continuumPairs) {
      const pairInfo = this.profile.continuumPairs[id];
      if (pairInfo) {
        const negAU = pairInfo.isNegative ? id : pairInfo.pairId;
        const posAU = pairInfo.isNegative ? pairInfo.pairId : id;
        this.setContinuum(negAU, posAU, pairInfo.isNegative ? -value : value, balance);
        return;
      }
    }

    this.auValues[id] = clamp01(value);
    if (balance !== undefined) {
      this.auBalances[id] = clampBalance(balance);
    }
  }

  getAU(id: number): number {
    return this.auValues[id] ?? 0;
  }

  setContinuum(negAU: number, posAU: number, continuumValue: number, balance?: number): void {
    const value = Math.max(-1, Math.min(1, continuumValue));
    if (value < 0) {
      this.setAU(posAU, 0, balance);
      this.setAU(negAU, Math.abs(value), balance);
      return;
    }
    if (value > 0) {
      this.setAU(negAU, 0, balance);
      this.setAU(posAU, value, balance);
      return;
    }
    this.setAU(negAU, 0, balance);
    this.setAU(posAU, 0, balance);
  }

  setViseme(visemeIndex: number, value: number, jawScale = 1): void {
    if (visemeIndex < 0 || visemeIndex >= this.visemeValues.length) return;
    this.visemeValues[visemeIndex] = clamp01(value);
    this.visemeJawScales[visemeIndex] = jawScale;
  }

  setVisemeById(slotId: string, value: number, jawScale = 1): void {
    const index = getVisemeSlotIndex(this.profile, slotId);
    if (index < 0) return;
    this.setViseme(index, value, jawScale);
  }

  setAUMixWeight(id: number, weight: number): void {
    this.mixWeights[id] = clamp01(weight);
  }

  evaluateFrameDelta(deltaSeconds?: number): FrameDelta {
    const morphWrites = new Map<string, NonNullable<FrameDelta['morphTargets']>[number]>();
    this.collectAUWrites(morphWrites);
    this.collectVisemeWrites(morphWrites);

    return {
      deltaSeconds,
      morphTargets: Array.from(morphWrites.values()),
      bones: this.collectBoneWrites(),
    };
  }

  private collectAUWrites(morphWrites: Map<string, NonNullable<FrameDelta['morphTargets']>[number]>): void {
    for (const [auIdText, entry] of Object.entries(this.profile.auToMorphs || {})) {
      const auId = Number(auIdText);
      if (Number.isNaN(auId) || !entry) continue;

      const mixWeight = this.isMixedAU(auId) ? this.getAUMixWeight(auId) : 1;
      const base = clamp01(this.auValues[auId] ?? 0) * mixWeight;
      const { left, right } = computeSideValues(base, this.auBalances[auId]);
      const meshNames = getMeshNamesForAUProfile(this.profile, auId);

      for (const morph of entry.left || []) {
        this.addMorphWrites(morphWrites, morph, meshNames, left);
      }
      for (const morph of entry.right || []) {
        this.addMorphWrites(morphWrites, morph, meshNames, right);
      }
      for (const morph of entry.center || []) {
        this.addMorphWrites(morphWrites, morph, meshNames, base);
      }
    }
  }

  private collectVisemeWrites(morphWrites: Map<string, NonNullable<FrameDelta['morphTargets']>[number]>): void {
    const meshNames = getMeshNamesForVisemeProfile(this.profile);
    const localMax = new Map<string, NonNullable<FrameDelta['morphTargets']>[number]>();

    for (let index = 0; index < this.visemeValues.length; index += 1) {
      const value = clamp01(this.visemeValues[index] ?? 0);
      for (const bindingTarget of getVisemeBindingTargets(this.profile, index)) {
        const weighted = clamp01(value * bindingTarget.weight);
        for (const resolved of this.resolveMorphTargets(bindingTarget.morph, meshNames)) {
          const key = morphWriteKey(resolved.mesh.id, resolved.morphTarget.id);
          const existing = localMax.get(key);
          if (!existing || weighted > existing.value) {
            localMax.set(key, {
              meshId: resolved.mesh.id,
              morphTargetId: resolved.morphTarget.id,
              value: weighted,
              mode: 'absolute',
            });
          }
        }
      }
    }

    for (const [key, write] of localMax) {
      const existing = morphWrites.get(key);
      if (!existing || write.value > existing.value) {
        morphWrites.set(key, write);
      }
    }
  }

  private collectBoneWrites(): BoneFrameDelta[] {
    const writes: BoneFrameDelta[] = [];
    const rotations = this.computeRotationState();

    for (const composite of this.profile.compositeRotations || []) {
      const bone = this.findBoneDescriptor(composite.node);
      if (!bone) continue;
      const transform = this.evaluateCompositeTransform(bone, composite, rotations[composite.node]);
      if (transform) {
        writes.push({
          boneId: bone.id,
          transform,
          mode: 'absolute',
          space: 'local',
        });
      }
    }

    for (const [nodeKey, translation] of Object.entries(this.computeTranslations())) {
      const bone = this.findBoneDescriptor(nodeKey);
      if (!bone) continue;
      const position = addVec3(bone.restTransform?.position, translation);
      upsertBoneWrite(writes, bone.id, { position });
    }

    const jawAmount = this.getActiveVisemeJawAmount();
    if (jawAmount > 1e-6) {
      const jawBinding = this.findAutoVisemeJawBinding();
      const jawBone = jawBinding ? this.findBoneDescriptor(jawBinding.node) : undefined;
      if (jawBone && jawBinding?.maxDegrees && jawBinding.channel) {
        const rotation = multiplyQuat(
          jawBone.restTransform?.rotation ?? identityQuat,
          quatFromChannel(jawBinding.channel, deg2rad(jawBinding.maxDegrees) * jawAmount * jawBinding.scale)
        );
        upsertBoneWrite(writes, jawBone.id, { rotation });
      }
    }

    return writes;
  }

  private computeRotationState(): RotationState {
    const rotations: RotationState = {};
    for (const composite of this.profile.compositeRotations || []) {
      rotations[composite.node] = {
        pitch: this.getCompositeAxisValueForNode(composite.node, composite.pitch),
        yaw: this.getCompositeAxisValueForNode(composite.node, composite.yaw),
        roll: this.getCompositeAxisValueForNode(composite.node, composite.roll),
      };
    }
    return rotations;
  }

  private evaluateCompositeTransform(
    bone: BoneDescriptor,
    composite: CompositeRotation,
    state: { pitch: number; yaw: number; roll: number } | undefined
  ): Transform | null {
    if (!state) return null;
    let rotation = bone.restTransform?.rotation ?? identityQuat;

    const applyAxis = (axisConfig: RotationAxis | null, direction: number) => {
      if (!axisConfig || Math.abs(direction) <= 1e-6) return;
      const binding = getCompositeAxisBinding(
        composite.node as BoneKey,
        axisConfig,
        direction,
        (auId) => this.getEffectiveBoneAUValue(auId, composite.node),
        this.profile.auToBones
      );
      if (!binding?.maxDegrees || !binding.channel) return;
      rotation = multiplyQuat(
        rotation,
        quatFromChannel(binding.channel, deg2rad(binding.maxDegrees) * Math.abs(direction) * binding.scale)
      );
    };

    applyAxis(composite.yaw, state.yaw);
    applyAxis(composite.pitch, state.pitch);
    applyAxis(composite.roll, state.roll);
    return { rotation };
  }

  private computeTranslations(): Record<string, Vec3> {
    const translations: Record<string, Vec3> = {};
    for (const [auIdText, bindings] of Object.entries(this.profile.auToBones || {})) {
      const auId = Number(auIdText);
      if (Number.isNaN(auId)) continue;
      const value = clamp01(this.auValues[auId] ?? 0);
      if (value <= 1e-6) continue;
      for (const binding of bindings || []) {
        if (binding.channel !== 'tx' && binding.channel !== 'ty' && binding.channel !== 'tz') continue;
        if (binding.maxUnits === undefined) continue;
        const current = translations[binding.node] ?? { x: 0, y: 0, z: 0 };
        const offset = clampSigned(value * binding.scale) * binding.maxUnits;
        translations[binding.node] = {
          x: binding.channel === 'tx' ? offset : current.x,
          y: binding.channel === 'ty' ? offset : current.y,
          z: binding.channel === 'tz' ? offset : current.z,
        };
      }
    }
    return translations;
  }

  private addMorphWrites(
    morphWrites: Map<string, NonNullable<FrameDelta['morphTargets']>[number]>,
    morph: MorphTargetRef,
    meshNames: string[],
    value: number
  ): void {
    for (const resolved of this.resolveMorphTargets(morph, meshNames)) {
      const key = morphWriteKey(resolved.mesh.id, resolved.morphTarget.id);
      const existing = morphWrites.get(key);
      // Max-combine: several AUs can bind the same morph target; an inactive
      // AU must not clobber an active one in full-state evaluation.
      if (existing && existing.value >= value) continue;
      morphWrites.set(key, {
        meshId: resolved.mesh.id,
        morphTargetId: resolved.morphTarget.id,
        value,
        mode: 'absolute',
      });
    }
  }

  private resolveMorphTargets(morph: MorphTargetRef, meshNames: string[]): MorphTargetLookup[] {
    const result: MorphTargetLookup[] = [];
    for (const meshName of meshNames) {
      const mesh = this.model.meshes.find((candidate) => candidate.name === meshName);
      if (!mesh) continue;
      const morphTargets = mesh.morphTargetIds
        .map((id) => this.model.morphTargets.find((candidate) => candidate.id === id))
        .filter((target): target is MorphTargetDescriptor => !!target);

      const target = typeof morph === 'number'
        ? morphTargets.find((candidate) => candidate.hostIndex === morph)
        : resolveMorphTargetByName(morphTargets, morph, this.profile);
      if (target) {
        result.push({ mesh, morphTarget: target });
      }
    }
    return result;
  }

  private findBoneDescriptor(nodeKey: string): BoneDescriptor | undefined {
    const configuredName = this.profile.boneNodes[nodeKey] || nodeKey;
    const prefix = this.profile.bonePrefix ?? '';
    const suffix = this.profile.boneSuffix ?? '';
    const prefixedName = prefix && !configuredName.startsWith(prefix)
      ? `${prefix}${configuredName}`
      : configuredName;
    const fullName = suffix && !prefixedName.endsWith(suffix)
      ? `${prefixedName}${suffix}`
      : prefixedName;
    const candidates = new Set([nodeKey, configuredName, fullName]);
    return this.model.bones.find((bone) => candidates.has(bone.name));
  }

  private findAutoVisemeJawBinding(): (BoneBinding & { channel: 'rx' | 'ry' | 'rz' }) | null {
    const candidates = [
      this.profile.auToBones[103]?.find(isRotationBoneBinding),
      this.profile.auToBones[26]?.find(isRotationBoneBinding),
    ].filter((binding): binding is BoneBinding & { channel: 'rx' | 'ry' | 'rz' } => !!binding);
    return candidates.find((binding) => !!this.findBoneDescriptor(binding.node))
      ?? candidates[0]
      ?? null;
  }

  private getActiveVisemeJawAmount(): number {
    const jawAmounts = getVisemeJawAmounts(this.profile) ?? [];
    let jawAmount = 0;
    for (let index = 0; index < this.visemeValues.length; index += 1) {
      const value = clamp01(this.visemeValues[index] ?? 0);
      if (value <= 1e-6) continue;
      const jawScale = this.visemeJawScales[index] ?? 1;
      if (Math.abs(jawScale) <= 1e-6) continue;
      jawAmount = Math.max(jawAmount, (jawAmounts[index] ?? 0) * value * jawScale);
    }
    return jawAmount;
  }

  private getCompositeAxisValueForNode(
    nodeKey: string,
    axisConfig: RotationAxis | null | undefined
  ): number {
    return getCompositeAxisValue(axisConfig, (auId) => this.getEffectiveBoneAUValue(auId, nodeKey));
  }

  private getEffectiveBoneAUValue(auId: number, nodeKey: string): number {
    const rawValue = clamp01(this.auValues[auId] ?? 0);
    if (rawValue <= 1e-6) return 0;
    const binding = this.profile.auToBones[auId]?.find((candidate) => candidate.node === nodeKey) ?? null;
    if (!binding?.side) return rawValue;
    return rawValue * getSideScale(this.auBalances[auId] ?? 0, binding.side);
  }

  private getAUMixWeight(auId: number): number {
    return this.mixWeights[auId] ?? this.profile.auMixDefaults?.[auId] ?? 1;
  }

  private isMixedAU(auId: number): boolean {
    const morphs = this.profile.auToMorphs[auId];
    const hasMorphs = !!(morphs?.left?.length || morphs?.right?.length || morphs?.center?.length);
    return !!(hasMorphs && this.profile.auToBones[auId]?.length);
  }
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

function computeSideValues(base: number, balance?: number): { left: number; right: number } {
  const b = clampBalance(balance ?? 0);
  if (b === 0) return { left: base, right: base };
  if (b < 0) return { left: base, right: base * (1 + b) };
  return { left: base * (1 - b), right: base };
}

function getSideScale(balance: number, side?: BoneBinding['side']): number {
  if (side !== 'left' && side !== 'right') return 1;
  const b = clampBalance(balance);
  if (side === 'left') return b > 0 ? 1 - b : 1;
  return b < 0 ? 1 + b : 1;
}

function addVec3(base: Vec3 | undefined, offset: Vec3): Vec3 {
  return {
    x: (base?.x ?? 0) + offset.x,
    y: (base?.y ?? 0) + offset.y,
    z: (base?.z ?? 0) + offset.z,
  };
}

function upsertBoneWrite(
  writes: BoneFrameDelta[],
  boneId: BoneId,
  transform: Transform
): void {
  const existingIndex = writes.findIndex((write) => write.boneId === boneId);
  if (existingIndex >= 0) {
    const existing = writes[existingIndex];
    writes[existingIndex] = {
      ...existing,
      transform: {
        ...existing.transform,
        ...transform,
      },
    };
    return;
  }

  writes.push({
    boneId,
    transform,
    mode: 'absolute',
    space: 'local',
  });
}

function quatFromChannel(channel: BoneBinding['channel'], radians: number): Quat {
  if (channel === 'rx') return quatFromAxis({ x: 1, y: 0, z: 0 }, radians);
  if (channel === 'ry') return quatFromAxis({ x: 0, y: 1, z: 0 }, radians);
  return quatFromAxis({ x: 0, y: 0, z: 1 }, radians);
}

function quatFromAxis(axis: Vec3, radians: number): Quat {
  const half = radians / 2;
  const s = Math.sin(half);
  return normalizeQuat({
    x: axis.x * s,
    y: axis.y * s,
    z: axis.z * s,
    w: Math.cos(half),
  });
}

function multiplyQuat(a: Quat, b: Quat): Quat {
  return normalizeQuat({
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  });
}

function normalizeQuat(q: Quat): Quat {
  const len = Math.hypot(q.x, q.y, q.z, q.w);
  if (len <= 1e-12) return identityQuat;
  return {
    x: q.x / len,
    y: q.y / len,
    z: q.z / len,
    w: q.w / len,
  };
}

function deg2rad(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function clampSigned(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < -1 ? -1 : value > 1 ? 1 : value;
}

function clampBalance(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-1, Math.min(1, value));
}

function morphWriteKey(meshId: MeshDescriptor['id'], morphTargetId: MorphTargetId): string {
  return `${meshId}:${morphTargetId}`;
}
