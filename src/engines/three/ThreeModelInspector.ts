import {
  Box3,
  Vector3,
} from 'three';
import type { AnimationClip, KeyframeTrack, Mesh, Object3D } from 'three';
import type { HostModelInspector, ModelDescriptor, MeshId, MorphTargetId, BoneId, Transform } from '../../core/contracts';
import type { Profile } from '../../mappings/types';
import type { NodeBase, ResolvedBones } from './types';

export interface ThreeAnimationTrackDescriptor {
  readonly name: string;
  readonly targetName: string;
  readonly property: string;
  readonly type: 'position' | 'rotation' | 'scale' | 'morph' | 'unknown';
  readonly keyframeCount: number;
  readonly valueSize: number;
  readonly valueRange?: { readonly min: readonly number[]; readonly max: readonly number[] };
}

export interface ThreeAnimationClipDescriptor {
  readonly name: string;
  readonly duration: number;
  readonly tracks: readonly ThreeAnimationTrackDescriptor[];
  readonly animatedBones: readonly string[];
  readonly animatedMorphs: readonly string[];
}

export interface ThreeModelInspectionOptions {
  readonly meshes?: readonly Mesh[];
  readonly profile?: Profile;
  readonly previousBones?: ResolvedBones;
  readonly animations?: readonly AnimationClip[];
}

export interface ThreeModelInspection {
  readonly descriptor: ModelDescriptor;
  readonly meshByName: Map<string, Mesh>;
  readonly allMeshes: Mesh[];
  readonly morphMeshes: Mesh[];
  readonly bones: ResolvedBones;
  readonly resolvedFaceMeshes: string[];
  readonly faceMesh: Mesh | null;
  readonly animations: ThreeAnimationClipDescriptor[];
}

type MorphTargetEntry = { name: string; index: number };

const meshId = (value: number) => value as MeshId;
const morphTargetId = (value: number) => value as MorphTargetId;
const boneId = (value: number) => value as BoneId;

export class ThreeModelInspector implements HostModelInspector<Object3D> {
  describeModel(model: Object3D): ModelDescriptor {
    return this.inspectModel(model).descriptor;
  }

  inspectModel(model: Object3D, options: ThreeModelInspectionOptions = {}): ThreeModelInspection {
    const allMeshes = this.collectMeshes(model);
    const morphMeshes = this.mergeMorphMeshes(options.meshes || [], collectMorphMeshes(model));
    const meshByName = this.buildMeshByName(model);
    const bones = options.profile
      ? this.resolveBones(model, options.profile, options.previousBones)
      : {};
    const resolvedFaceMeshes = options.profile
      ? this.resolveFaceMeshes(morphMeshes, meshByName, bones, options.profile)
      : [];
    const faceMesh = resolvedFaceMeshes.length > 0
      ? meshByName.get(resolvedFaceMeshes[0]) || null
      : null;
    const animations = this.describeAnimations(options.animations || []);
    const descriptor = this.buildDescriptor(model, allMeshes, bones, animations);

    return {
      descriptor,
      meshByName,
      allMeshes,
      morphMeshes,
      bones,
      resolvedFaceMeshes,
      faceMesh,
      animations,
    };
  }

  collectMeshes(root: Object3D): Mesh[] {
    const meshes: Mesh[] = [];
    root.traverse((obj: any) => {
      if (obj.isMesh) {
        meshes.push(obj as Mesh);
      }
    });
    return meshes;
  }

  buildMeshByName(root: Object3D): Map<string, Mesh> {
    const meshByName = new Map<string, Mesh>();
    root.traverse((obj: any) => {
      if (obj.isMesh && obj.name) {
        meshByName.set(obj.name, obj as Mesh);
      }
    });
    return meshByName;
  }

  resolveBones(root: Object3D, profile: Profile, previousBones: ResolvedBones = {}): ResolvedBones {
    const resolved: ResolvedBones = {};

    const snapshot = (obj: Object3D): NodeBase => ({
      obj,
      basePos: { x: obj.position.x, y: obj.position.y, z: obj.position.z },
      baseQuat: obj.quaternion.clone(),
      baseEuler: { x: obj.rotation.x, y: obj.rotation.y, z: obj.rotation.z, order: obj.rotation.order },
    });

    const snapshotPreservingBasePose = (obj: Object3D): NodeBase => {
      const existing = Object.values(previousBones).find((entry) => entry?.obj === obj);
      if (!existing) {
        return snapshot(obj);
      }

      return {
        obj,
        basePos: { ...existing.basePos },
        baseQuat: existing.baseQuat.clone(),
        baseEuler: { ...existing.baseEuler },
      };
    };

    const prefix = profile.bonePrefix || '';
    const suffix = profile.boneSuffix || '';
    const suffixRegex = profile.suffixPattern
      ? new RegExp(profile.suffixPattern)
      : null;

    const findNode = (baseName?: string | null): Object3D | undefined => {
      if (!baseName) return undefined;

      const directMatch = root.getObjectByName(baseName);
      if (directMatch) return directMatch;

      const prefixedBase = prefix && !baseName.startsWith(prefix)
        ? `${prefix}${baseName}`
        : baseName;
      const fullName = suffix && !prefixedBase.endsWith(suffix)
        ? `${prefixedBase}${suffix}`
        : prefixedBase;
      const exactMatch = root.getObjectByName(fullName);
      if (exactMatch) return exactMatch;

      if (suffixRegex) {
        let found: Object3D | undefined;
        root.traverse((obj: any) => {
          if (found) return;
          if (obj.name && obj.name.startsWith(fullName)) {
            const candidateSuffix = obj.name.slice(fullName.length);
            if (candidateSuffix === '' || suffixRegex.test(candidateSuffix)) {
              found = obj;
            }
          }
        });
        if (found) return found;
      }

      return undefined;
    };

    const addResolvedBone = (key: string, node: Object3D) => {
      const entry = snapshotPreservingBasePose(node);
      resolved[key] = entry;
      if (node.name) {
        resolved[node.name] = entry;
      }
    };

    for (const [key, nodeName] of Object.entries(profile.boneNodes || {})) {
      const node = findNode(nodeName);
      if (node) {
        addResolvedBone(key, node);
        if (nodeName) {
          resolved[nodeName] = resolved[key]!;
        }
      }
    }

    if (!resolved.EYE_L && profile.eyeMeshNodes) {
      const node = findNode(profile.eyeMeshNodes.LEFT);
      if (node) {
        addResolvedBone('EYE_L', node);
      }
    }
    if (!resolved.EYE_R && profile.eyeMeshNodes) {
      const node = findNode(profile.eyeMeshNodes.RIGHT);
      if (node) {
        addResolvedBone('EYE_R', node);
      }
    }

    const referencedNodes = new Set<string>();
    Object.values(profile.auToBones ?? {}).forEach((bindings) => {
      bindings.forEach((binding) => referencedNodes.add(binding.node));
    });
    profile.compositeRotations?.forEach((composite) => referencedNodes.add(composite.node));
    Object.values(profile.continuumPairs ?? {}).forEach((pair) => {
      if (pair?.node) referencedNodes.add(pair.node);
    });
    profile.annotationRegions?.forEach((region) => {
      region.bones?.forEach((boneName) => referencedNodes.add(boneName));
    });

    referencedNodes.forEach((nodeKey) => {
      if (resolved[nodeKey]) return;
      const configuredName = profile.boneNodes?.[nodeKey] ?? nodeKey;
      const node = findNode(configuredName);
      if (node) {
        addResolvedBone(nodeKey, node);
        if (configuredName) {
          resolved[configuredName] = resolved[nodeKey]!;
        }
      }
    });

    return resolved;
  }

  resolveFaceMeshes(
    meshes: readonly Mesh[],
    meshByName: ReadonlyMap<string, Mesh>,
    bones: ResolvedBones,
    profile: Profile
  ): string[] {
    const faceMeshNames = profile.morphToMesh?.face || [];
    const availableMorphMeshes = meshes.filter((m) => hasMorphTargets(m));
    const defaultFace = meshes.find((m) => faceMeshNames.includes(m.name));
    if (defaultFace) {
      return [defaultFace.name];
    }

    const candidateByMorph = meshes.find((m) => {
      const dict = m.morphTargetDictionary;
      return dict && typeof dict === 'object' && 'Brow_Drop_L' in dict;
    });
    if (candidateByMorph) {
      return [candidateByMorph.name];
    }

    const headNodeKey = profile.auToBones?.[51]?.[0]?.node
      ?? profile.auToBones?.[52]?.[0]?.node
      ?? profile.compositeRotations?.find((composite) => (
        composite.yaw?.aus.includes(51)
        || composite.yaw?.aus.includes(52)
        || composite.pitch?.aus.includes(53)
        || composite.pitch?.aus.includes(54)
        || composite.roll?.aus.includes(55)
        || composite.roll?.aus.includes(56)
      ))?.node
      ?? 'HEAD';
    const head = bones[headNodeKey]?.obj ?? bones.HEAD?.obj;
    if (head && availableMorphMeshes.length > 0) {
      const headPos = new Vector3();
      (head as any).getWorldPosition?.(headPos);
      const headCandidates = availableMorphMeshes.map((mesh) => {
        const box = new Box3().setFromObject(mesh as any);
        const center = new Vector3();
        box.getCenter(center);
        const distance = box.containsPoint(headPos) ? 0 : center.distanceTo(headPos);
        const morphCount = mesh.morphTargetDictionary
          ? Object.keys(mesh.morphTargetDictionary).length
          : 0;
        const name = mesh.name.toLowerCase();
        const penalty = /eye|occlusion|tear|teeth|tongue|hair|lash/.test(name) ? 10 : 0;
        return { name: mesh.name, distance, morphCount, penalty };
      });

      headCandidates.sort((a, b) => {
        if (a.distance !== b.distance) return a.distance - b.distance;
        if (a.penalty !== b.penalty) return a.penalty - b.penalty;
        return b.morphCount - a.morphCount;
      });

      const best = headCandidates[0];
      const extras = headCandidates
        .filter((entry) => /brow|eyebrow/.test(entry.name.toLowerCase()))
        .map((entry) => entry.name);

      return [best.name, ...extras].filter((value, index, arr) => arr.indexOf(value) === index);
    }

    if (availableMorphMeshes.length > 0) {
      const best = availableMorphMeshes.reduce((prev, current) => {
        const prevCount = prev.morphTargetDictionary ? Object.keys(prev.morphTargetDictionary).length : 0;
        const currCount = current.morphTargetDictionary ? Object.keys(current.morphTargetDictionary).length : 0;
        return currCount > prevCount ? current : prev;
      });
      const browExtras = availableMorphMeshes
        .filter((m) => {
          const dict = m.morphTargetDictionary || {};
          const morphKeys = Object.keys(dict);
          return /brow|eyebrow/i.test(m.name) || morphKeys.some((k) => /brow/i.test(k));
        })
        .map((m) => m.name);
      return [best.name, ...browExtras].filter((value, index, arr) => arr.indexOf(value) === index);
    }

    return faceMeshNames.filter((name) => meshByName.has(name));
  }

  describeAnimations(animations: readonly AnimationClip[]): ThreeAnimationClipDescriptor[] {
    return animations.map((clip) => {
      const tracks = clip.tracks.map((track) => this.describeTrack(track));
      const animatedBones = new Set<string>();
      const animatedMorphs = new Set<string>();

      for (const track of tracks) {
        if (track.type === 'rotation' || track.type === 'position') {
          animatedBones.add(track.targetName);
        } else if (track.type === 'morph') {
          animatedMorphs.add(track.name);
        }
      }

      return {
        name: clip.name,
        duration: clip.duration,
        tracks,
        animatedBones: Array.from(animatedBones),
        animatedMorphs: Array.from(animatedMorphs),
      };
    });
  }

  private mergeMorphMeshes(inputMeshes: readonly Mesh[], collectedMeshes: readonly Mesh[]): Mesh[] {
    const meshByKey = new Map<string, Mesh>();
    const addMesh = (mesh: Mesh) => {
      const key = mesh.name || (mesh as any).uuid;
      if (!meshByKey.has(key)) {
        meshByKey.set(key, mesh);
      }
    };

    inputMeshes.forEach(addMesh);
    collectedMeshes.forEach(addMesh);
    return Array.from(meshByKey.values());
  }

  private buildDescriptor(
    model: Object3D,
    meshes: readonly Mesh[],
    resolvedBones: ResolvedBones,
    animations: readonly ThreeAnimationClipDescriptor[]
  ): ModelDescriptor {
    const meshIds = new Map<Mesh, MeshId>();
    meshes.forEach((mesh, index) => meshIds.set(mesh, meshId(index + 1)));

    const boneObjects = this.collectDescriptorBoneObjects(model, resolvedBones);
    const boneIds = new Map<Object3D, BoneId>();
    boneObjects.forEach((bone, index) => boneIds.set(bone, boneId(index + 1)));

    const boneParentIds = new Map<Object3D, BoneId | undefined>();
    for (const bone of boneObjects) {
      boneParentIds.set(bone, this.findNearestDescriptorBoneId(bone.parent, boneIds));
    }

    const boneChildIds = new Map<Object3D, BoneId[]>();
    for (const bone of boneObjects) {
      boneChildIds.set(bone, []);
    }
    for (const bone of boneObjects) {
      const parentId = boneParentIds.get(bone);
      if (parentId === undefined) continue;
      const parent = boneObjects.find((candidate) => boneIds.get(candidate) === parentId);
      if (parent) {
        boneChildIds.get(parent)?.push(boneIds.get(bone)!);
      }
    }

    const morphTargets = [];
    const morphTargetIdsByMesh = new Map<Mesh, MorphTargetId[]>();
    let nextMorphTargetId = 1;
    for (const mesh of meshes) {
      const ids: MorphTargetId[] = [];
      for (const entry of getMorphTargetEntries(mesh)) {
        const id = morphTargetId(nextMorphTargetId++);
        ids.push(id);
        morphTargets.push({
          id,
          meshId: meshIds.get(mesh)!,
          name: entry.name,
          hostIndex: entry.index,
        });
      }
      morphTargetIdsByMesh.set(mesh, ids);
    }

    return {
      id: model.uuid,
      name: model.name || undefined,
      meshes: meshes.map((mesh) => ({
        id: meshIds.get(mesh)!,
        name: mesh.name,
        parentBoneId: this.findNearestDescriptorBoneId(mesh.parent, boneIds),
        morphTargetIds: morphTargetIdsByMesh.get(mesh) || [],
        visible: mesh.visible,
      })),
      morphTargets,
      bones: boneObjects.map((bone) => ({
        id: boneIds.get(bone)!,
        name: bone.name,
        parentId: boneParentIds.get(bone),
        childIds: boneChildIds.get(bone) || [],
        restTransform: objectTransform(bone),
      })),
      metadata: animations.length > 0 ? { animations } : undefined,
    };
  }

  private collectDescriptorBoneObjects(model: Object3D, resolvedBones: ResolvedBones): Object3D[] {
    const boneObjects: Object3D[] = [];
    const addBone = (obj: Object3D) => {
      if (!boneObjects.includes(obj)) {
        boneObjects.push(obj);
      }
    };

    model.traverse((obj: any) => {
      if (obj.isBone || obj.type === 'Bone') {
        addBone(obj as Object3D);
      }
    });

    for (const entry of Object.values(resolvedBones)) {
      if (entry?.obj) {
        addBone(entry.obj);
      }
    }

    return boneObjects;
  }

  private findNearestDescriptorBoneId(parent: Object3D | null, boneIds: ReadonlyMap<Object3D, BoneId>): BoneId | undefined {
    let current = parent;
    while (current) {
      const id = boneIds.get(current);
      if (id !== undefined) return id;
      current = current.parent;
    }
    return undefined;
  }

  private describeTrack(track: KeyframeTrack): ThreeAnimationTrackDescriptor {
    const parts = track.name.split('.');
    const targetName = parts[0];
    const property = parts.slice(1).join('.');
    const type = getTrackType(property);
    const valueSize = track.getValueSize();
    const valueRange = getValueRange(track.values, valueSize);

    return {
      name: track.name,
      targetName,
      property,
      type,
      keyframeCount: track.times.length,
      valueSize,
      valueRange,
    };
  }
}

export function collectMorphMeshes(root: Object3D): Mesh[] {
  const meshes: Mesh[] = [];
  root.traverse((obj: any) => {
    if (obj.isMesh) {
      const dict = obj.morphTargetDictionary;
      const infl = obj.morphTargetInfluences;
      if ((dict && Object.keys(dict).length > 0) || (Array.isArray(infl) && infl.length > 0)) {
        meshes.push(obj as Mesh);
      }
    }
  });
  return meshes;
}

function hasMorphTargets(mesh: Mesh): boolean {
  const dict = mesh.morphTargetDictionary;
  const infl = mesh.morphTargetInfluences;
  return !!(dict && Object.keys(dict).length > 0) || !!(Array.isArray(infl) && infl.length > 0);
}

function getMorphTargetEntries(mesh: Mesh): MorphTargetEntry[] {
  const meshDictionary = mesh.morphTargetDictionary as Record<string, number> | undefined;
  const geometryDictionary = (mesh.geometry as any).morphTargetDictionary as Record<string, number> | undefined;
  const dictionary = meshDictionary || geometryDictionary;

  if (dictionary) {
    return Object.entries(dictionary)
      .map(([name, index]) => ({ name, index }))
      .sort((a, b) => a.index - b.index);
  }

  const influences = mesh.morphTargetInfluences;
  if (!influences || influences.length === 0) {
    return [];
  }

  return influences.map((_, index) => ({ name: `morph_${index}`, index }));
}

function objectTransform(obj: Object3D): Transform {
  return {
    position: { x: obj.position.x, y: obj.position.y, z: obj.position.z },
    rotation: { x: obj.quaternion.x, y: obj.quaternion.y, z: obj.quaternion.z, w: obj.quaternion.w },
    scale: { x: obj.scale.x, y: obj.scale.y, z: obj.scale.z },
  };
}

function getTrackType(property: string): ThreeAnimationTrackDescriptor['type'] {
  if (property.includes('position')) return 'position';
  if (property.includes('quaternion') || property.includes('rotation')) return 'rotation';
  if (property.includes('scale')) return 'scale';
  if (property.includes('morphTargetInfluences')) return 'morph';
  return 'unknown';
}

function getValueRange(values: KeyframeTrack['values'], valueSize: number): ThreeAnimationTrackDescriptor['valueRange'] {
  if (values.length === 0) return undefined;

  const min = Array(valueSize).fill(Infinity);
  const max = Array(valueSize).fill(-Infinity);

  for (let i = 0; i < values.length; i += valueSize) {
    for (let j = 0; j < valueSize; j += 1) {
      const value = values[i + j];
      if (value < min[j]) min[j] = value;
      if (value > max[j]) max[j] = value;
    }
  }

  return { min, max };
}
