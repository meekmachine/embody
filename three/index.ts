import {
  AdditiveBlending,
  BufferAttribute,
  InterpolateDiscrete,
  MultiplyBlending,
  NoBlending,
  NormalBlending,
  PropertyBinding,
  SubtractiveBlending,
} from 'three';
import type {
  AnimationClip,
  KeyframeTrack,
  Material,
  Mesh,
  Object3D,
} from 'three';

export const THREE_BLENDING_MODES = {
  Normal: NormalBlending,
  Additive: AdditiveBlending,
  Subtractive: SubtractiveBlending,
  Multiply: MultiplyBlending,
  None: NoBlending,
} as const;

type BoneEntry = {
  obj: Object3D;
  basePos: { x: number; y: number; z: number };
  baseQuat: ReturnType<Object3D['quaternion']['clone']>;
  baseEuler: { x: number; y: number; z: number; order: string };
};

const MORPH_ATTRIBUTE_SEMANTICS = ['position', 'normal', 'tangent', 'color'] as const;
type MorphAttributeSemantic = typeof MORPH_ATTRIBUTE_SEMANTICS[number];

const createNeutralMorphAttribute = (
  geometry: Mesh['geometry'],
  semantic: MorphAttributeSemantic,
  name: string,
) => {
  const base = geometry.getAttribute(semantic);
  if (!base) throw new Error(`Cannot create ${semantic} morph data without a base attribute`);

  const values = new Float32Array(base.count * base.itemSize);
  if (!geometry.morphTargetsRelative) {
    for (let vertexIndex = 0; vertexIndex < base.count; vertexIndex += 1) {
      for (let component = 0; component < base.itemSize; component += 1) {
        values[vertexIndex * base.itemSize + component] = base.getComponent(vertexIndex, component);
      }
    }
  }

  const attribute = new BufferAttribute(values, base.itemSize);
  attribute.name = name;
  return attribute;
};

export type ThreeModelInspection = {
  descriptor: Record<string, unknown>;
  meshByName: Map<string, Mesh>;
  allMeshes: Mesh[];
  morphMeshes: Mesh[];
  bones: Record<string, BoneEntry>;
  meshBindings: Map<number, Mesh>;
  morphBindings: Map<number, { mesh: Mesh; index: number }>;
  boneBindings: Map<number, Object3D>;
  objectBindings: Map<number, Object3D>;
};

const transform = (obj: Object3D) => ({
  position: { x: obj.position.x, y: obj.position.y, z: obj.position.z },
  rotation: { x: obj.quaternion.x, y: obj.quaternion.y, z: obj.quaternion.z, w: obj.quaternion.w },
  scale: { x: obj.scale.x, y: obj.scale.y, z: obj.scale.z },
});

const snapshot = (obj: Object3D): BoneEntry => ({
  obj,
  basePos: { x: obj.position.x, y: obj.position.y, z: obj.position.z },
  baseQuat: obj.quaternion.clone(),
  baseEuler: { x: obj.rotation.x, y: obj.rotation.y, z: obj.rotation.z, order: obj.rotation.order },
});

const boneDepth = (obj: Object3D) => {
  let depth = 0;
  let parent = obj.parent;
  while (parent) {
    if ((parent as any).isBone || parent.type === 'Bone') depth += 1;
    parent = parent.parent;
  }
  return depth;
};

const morphEntries = (mesh: Mesh) => {
  const dictionary = mesh.morphTargetDictionary
    ?? (mesh.geometry as unknown as { morphTargetDictionary?: Record<string, number> }).morphTargetDictionary;
  if (dictionary) {
    return Object.entries(dictionary)
      .map(([name, index]) => ({ name, index }))
      .sort((left, right) => left.index - right.index);
  }
  return (mesh.morphTargetInfluences ?? []).map((_, index) => ({ name: `morph_${index}`, index }));
};

export class ThreeModelInspector {
  inspectModel(model: Object3D, options: { meshes?: Mesh[]; profile?: any } = {}): ThreeModelInspection {
    const objects: Object3D[] = [];
    const allMeshes: Mesh[] = [];
    const boneObjects: Object3D[] = [];
    model.traverse((obj: any) => {
      objects.push(obj);
      if (obj.isMesh) allMeshes.push(obj);
      if (obj.isBone || obj.type === 'Bone') boneObjects.push(obj);
    });
    const inputMeshes = options.meshes ?? [];
    const morphMeshes = Array.from(new Set([...inputMeshes, ...allMeshes.filter((mesh) => morphEntries(mesh).length > 0)]));
    const meshByName = new Map(allMeshes.filter((mesh) => mesh.name).map((mesh) => [mesh.name, mesh]));
    const meshBindings = new Map(allMeshes.map((mesh, index) => [index + 1, mesh]));
    const boneBindings = new Map(boneObjects.map((bone, index) => [index + 1, bone]));
    const objectBindings = new Map(objects.map((object, index) => [index + 1, object]));
    const meshIds = new Map(Array.from(meshBindings, ([id, mesh]) => [mesh, id]));
    const boneIds = new Map(Array.from(boneBindings, ([id, bone]) => [bone, id]));
    const objectIds = new Map(Array.from(objectBindings, ([id, object]) => [object, id]));
    const morphBindings = new Map<number, { mesh: Mesh; index: number }>();
    const morphTargets: Array<Record<string, unknown>> = [];
    const morphIdsByMesh = new Map<Mesh, number[]>();
    let morphId = 1;
    for (const mesh of allMeshes) {
      const ids: number[] = [];
      for (const entry of morphEntries(mesh)) {
        ids.push(morphId);
        morphBindings.set(morphId, { mesh, index: entry.index });
        morphTargets.push({
          id: morphId,
          meshId: meshIds.get(mesh),
          name: entry.name,
          hostIndex: entry.index,
          initialValue: mesh.morphTargetInfluences?.[entry.index] ?? 0,
        });
        morphId += 1;
      }
      morphIdsByMesh.set(mesh, ids);
    }
    const bones: Record<string, BoneEntry> = {};
    for (const bone of boneObjects) {
      if (bone.name) bones[bone.name] = snapshot(bone);
    }
    const profile = options.profile;
    if (profile?.boneNodes) {
      for (const [key, base] of Object.entries(profile.boneNodes as Record<string, string>)) {
        const prefix = profile.bonePrefix ?? '';
        const suffix = profile.boneSuffix ?? '';
        const name = `${base.startsWith(prefix) ? '' : prefix}${base}${base.endsWith(suffix) ? '' : suffix}`;
        const object = model.getObjectByName(name) ?? model.getObjectByName(base);
        if (object) bones[key] = bones[object.name] ?? snapshot(object);
      }
    }
    return {
      descriptor: {
        id: model.uuid,
        name: model.name || undefined,
        meshes: allMeshes.map((mesh) => ({
          id: meshIds.get(mesh),
          name: mesh.name,
          morphTargetIds: morphIdsByMesh.get(mesh) ?? [],
          visible: mesh.visible,
        })),
        morphTargets,
        bones: boneObjects.map((bone) => {
          const world = bone.getWorldPosition(bone.position.clone());
          const parent = bone.parent && ((bone.parent as any).isBone || bone.parent.type === 'Bone')
            ? bone.parent.name || null
            : null;
          return {
            id: boneIds.get(bone),
            name: bone.name,
            parentName: parent,
            worldPosition: { x: world.x, y: world.y, z: world.z },
            depth: boneDepth(bone),
            restTransform: transform(bone),
          };
        }),
        objects: objects.map((object) => ({
          id: objectIds.get(object),
          name: object.name,
          isBone: !!((object as any).isBone || object.type === 'Bone'),
          isCamera: !!(object as any).isCamera,
          restTransform: transform(object),
        })),
      },
      meshByName,
      allMeshes,
      morphMeshes,
      bones,
      meshBindings,
      morphBindings,
      boneBindings,
      objectBindings,
    };
  }
}

const findTrackTarget = (model: Object3D, track: KeyframeTrack) => {
  try {
    const parsed = PropertyBinding.parseTrackName(track.name);
    const key = parsed.objectName === 'bones' && parsed.objectIndex
      ? String(parsed.objectIndex)
      : parsed.nodeName;
    const object = key
      ? model.getObjectByProperty('uuid', key) ?? PropertyBinding.findNode(model, key)
      : model;
    return { parsed, object };
  } catch {
    return null;
  }
};

export function serializeAnimationClips(
  model: Object3D,
  clips: readonly AnimationClip[],
  inspection: ThreeModelInspection,
) {
  const meshIds = new Map(Array.from(inspection.meshBindings, ([id, mesh]) => [mesh, id]));
  const boneIds = new Map(Array.from(inspection.boneBindings, ([id, bone]) => [bone, id]));
  const objectIds = new Map(Array.from(inspection.objectBindings, ([id, object]) => [object, id]));
  return clips.map((clip) => {
    const tracks: Array<Record<string, unknown>> = [];
    const channelKinds = new Map<string, number>();
    const channelId = (kind: 'face' | 'body' | 'scene') => {
      const existing = channelKinds.get(kind);
      if (existing) return existing;
      const id = channelKinds.size + 1;
      channelKinds.set(kind, id);
      return id;
    };
    clip.tracks.forEach((track, index) => {
      const found = findTrackTarget(model, track);
      if (!found?.object) return;
      const { parsed, object } = found;
      let target: Record<string, unknown> | null = null;
      const property = parsed.propertyName;
      if ((property === 'morphTargetInfluences' || property === 'weights') && (object as any).isMesh) {
        const mesh = object as Mesh;
        const requested = parsed.propertyIndex;
        const indexValue = typeof requested === 'number'
          ? requested
          : Number.isFinite(Number(requested))
            ? Number(requested)
            : mesh.morphTargetDictionary?.[String(requested)];
        const binding = Array.from(inspection.morphBindings).find(([, entry]) => entry.mesh === mesh && entry.index === indexValue);
        if (binding) target = { kind: 'morphTarget', meshId: meshIds.get(mesh), morphTargetId: binding[0] };
      } else if (property === 'visible' && (object as any).isMesh) {
        target = { kind: 'meshVisibility', meshId: meshIds.get(object as Mesh) };
      } else {
        const transformProperty = property === 'quaternion' || property === 'rotation'
          ? 'rotation'
          : property === 'position'
            ? 'position'
            : property === 'scale'
              ? 'scale'
              : null;
        if (transformProperty) {
          const boneId = boneIds.get(object);
          target = boneId
            ? { kind: 'boneTransform', boneId, property: transformProperty }
            : { kind: 'objectTransform', objectId: objectIds.get(object), property: transformProperty };
        }
      }
      if (!target) return;
      const kind = target.kind === 'morphTarget'
        ? 'face'
        : target.kind === 'boneTransform'
          ? 'body'
          : 'scene';
      const size = track.getValueSize();
      tracks.push({
        id: index + 1,
        channelId: channelId(kind),
        target,
        valueType: size === 4 ? 'quat' : size === 3 ? 'vec3' : 'scalar',
        times: Array.from(track.times),
        values: Array.from(track.values),
        interpolation: track.getInterpolation() === InterpolateDiscrete ? 'step' : 'linear',
        sourceName: track.name,
      });
    });
    return {
      name: clip.name,
      durationSeconds: clip.duration,
      channels: Array.from(channelKinds, ([kind, id]) => ({ id, kind, name: kind })),
      tracks,
    };
  });
}

type MaterialConfig = {
  renderOrder?: number;
  transparent?: boolean;
  opacity?: number;
  depthWrite?: boolean;
  depthTest?: boolean;
  blending?: keyof typeof THREE_BLENDING_MODES;
};

const materials = (value: Material | Material[] | undefined): Material[] =>
  value ? (Array.isArray(value) ? value : [value]) : [];

export class ThreeFrameApplier {
  private meshes = new Map<number, Mesh>();
  private morphs = new Map<number, { mesh: Mesh; index: number }>();
  private bones = new Map<number, Object3D>();
  private objects = new Map<number, Object3D>();
  private originalEmissive = new Map<string, { color: number; intensity: number }>();

  setBindings(inspection: ThreeModelInspection) {
    this.meshes = new Map(inspection.meshBindings);
    this.morphs = new Map(inspection.morphBindings);
    this.bones = new Map(inspection.boneBindings);
    this.objects = new Map(inspection.objectBindings);
  }

  applyPackedMorphFrameDelta(values: ArrayLike<number>, stride = 4) {
    for (let offset = 0; offset + stride <= values.length; offset += stride) {
      const binding = this.morphs.get(values[offset + 1]);
      if (binding?.mesh.morphTargetInfluences) {
        binding.mesh.morphTargetInfluences[binding.index] = values[offset + 2] ?? 0;
      }
    }
  }

  applyPackedBoneFrameDelta(values: ArrayLike<number>, stride = 9) {
    for (let offset = 0; offset + stride <= values.length; offset += stride) {
      const bone = this.bones.get(values[offset]);
      if (!bone) continue;
      const flags = values[offset + 8] ?? 0;
      if (flags & 1) bone.position.set(values[offset + 1], values[offset + 2], values[offset + 3]);
      if (flags & 2) bone.quaternion.set(values[offset + 4], values[offset + 5], values[offset + 6], values[offset + 7]).normalize();
      bone.updateMatrixWorld(false);
    }
  }

  applySceneFrame(frame: string | Record<string, any>) {
    const value = typeof frame === 'string' ? JSON.parse(frame) : frame;
    for (const write of value.boneScales ?? []) this.bones.get(write.boneId)?.scale.fromArray(write.scale);
    for (const write of value.objects ?? []) {
      const object = this.objects.get(write.objectId);
      if (!object) continue;
      if (write.position) object.position.fromArray(write.position);
      if (write.rotation) object.quaternion.fromArray(write.rotation).normalize();
      if (write.scale) object.scale.fromArray(write.scale);
      object.updateMatrixWorld(false);
    }
    for (const write of value.meshes ?? []) {
      const mesh = this.meshes.get(write.meshId);
      if (mesh) mesh.visible = write.visible;
    }
  }

  applyMeshMaterialConfigs(root: Object3D, configs: Record<string, { material?: MaterialConfig }>) {
    root.traverse((object: any) => {
      if (object.isMesh && object.name && configs[object.name]?.material) {
        this.applyMaterial(object, configs[object.name].material!);
      }
    });
  }

  getMeshMaterialConfig(root: Object3D, name: string) {
    let result: Record<string, unknown> | null = null;
    this.visitMesh(root, name, (mesh) => {
      const material: any = materials((mesh as any).material)[0];
      if (!material) return;
      const blending = Object.entries(THREE_BLENDING_MODES).find(([, value]) => value === material.blending)?.[0] ?? 'Normal';
      result = { renderOrder: mesh.renderOrder, transparent: material.transparent, opacity: material.opacity, depthWrite: material.depthWrite, depthTest: material.depthTest, blending };
    });
    return result;
  }

  setMeshMaterialConfig(root: Object3D, name: string, config: MaterialConfig) {
    this.visitMesh(root, name, (mesh) => this.applyMaterial(mesh, config));
  }

  setMeshVisible(root: Object3D, name: string, visible: boolean) {
    this.visitMesh(root, name, (mesh) => { mesh.visible = visible; });
  }

  highlightMesh(root: Object3D, name: string | null, color = 0x00ffff, intensity = 0.5) {
    root.traverse((object: any) => {
      if (!object.isMesh) return;
      for (const material of materials(object.material) as any[]) {
        if (!material.emissive) continue;
        const key = `${object.uuid}:${material.uuid}`;
        if (name === object.name) {
          if (!this.originalEmissive.has(key)) this.originalEmissive.set(key, { color: material.emissive.getHex(), intensity: material.emissiveIntensity ?? 0 });
          material.emissive.setHex(color);
          material.emissiveIntensity = intensity;
        } else {
          const original = this.originalEmissive.get(key);
          if (original) {
            material.emissive.setHex(original.color);
            material.emissiveIntensity = original.intensity;
          }
        }
      }
    });
  }

  applyHairAppearance(meshes: readonly Mesh[], appearance: any) {
    for (const mesh of meshes) {
      for (const material of materials((mesh as any).material) as any[]) {
        if (appearance.baseColor && material.color) material.color.set(appearance.baseColor);
        if (appearance.emissive && material.emissive) material.emissive.set(appearance.emissive);
        if (typeof appearance.emissiveIntensity === 'number') material.emissiveIntensity = appearance.emissiveIntensity;
        material.needsUpdate = true;
      }
    }
  }

  addMorphTarget(root: Object3D, target: any, options: any = {}) {
    const mesh = root.getObjectByName(target.meshName) as Mesh | null;
    if (!mesh || !(mesh as any).isMesh) throw new Error(`Mesh not found: ${target.meshName}`);
    if (options.forceGeometryReplacement !== false) mesh.geometry = mesh.geometry.clone();
    const geometry: any = mesh.geometry;
    const dictionary = { ...(mesh.morphTargetDictionary ?? {}) };
    const configuredIndex = dictionary[target.name];
    const existing = Number.isInteger(configuredIndex) && configuredIndex >= 0
      ? configuredIndex
      : undefined;
    if (existing !== undefined && !options.replace) throw new Error(`Morph target already exists: ${target.name}`);

    const usedIndices = Object.values(dictionary)
      .filter((value): value is number => Number.isInteger(value) && value >= 0);
    const currentTargetCount = Math.max(
      0,
      ...Object.values(geometry.morphAttributes as Record<string, unknown[]>).map((attributes) => attributes?.length ?? 0),
      usedIndices.length > 0 ? Math.max(...usedIndices) + 1 : 0,
      mesh.morphTargetInfluences?.length ?? 0,
    );
    const index = existing ?? currentTargetCount;
    const targetCount = Math.max(currentTargetCount, index + 1);
    geometry.morphTargetsRelative = target.relative !== false;

    for (const semantic of MORPH_ATTRIBUTE_SEMANTICS) {
      const data = target[semantic] as ArrayLike<number> | undefined;
      const existingAttributes = geometry.morphAttributes[semantic] as Array<BufferAttribute | undefined> | undefined;
      if (!data && (!existingAttributes || existingAttributes.length === 0)) continue;

      const base = geometry.getAttribute(semantic);
      if (!base || (data && data.length !== base.count * base.itemSize)) {
        throw new Error(`Invalid ${semantic} morph data length`);
      }

      const attributes = [...(existingAttributes ?? [])];
      for (let targetIndex = 0; targetIndex < targetCount; targetIndex += 1) {
        if (targetIndex === index && data) {
          const attribute = new BufferAttribute(new Float32Array(Array.from(data)), base.itemSize);
          attribute.name = target.name;
          attributes[targetIndex] = attribute;
        } else if (!attributes[targetIndex] || targetIndex === index) {
          attributes[targetIndex] = createNeutralMorphAttribute(
            geometry,
            semantic,
            targetIndex === index ? target.name : `morph_${targetIndex}`,
          );
        }
      }
      geometry.morphAttributes[semantic] = attributes;
    }

    dictionary[target.name] = index;
    mesh.morphTargetDictionary = dictionary;
    (geometry as any).morphTargetDictionary = { ...dictionary };
    const influences = [...(mesh.morphTargetInfluences ?? [])];
    while (influences.length <= index) influences.push(0);
    if (options.resetInfluence !== false) influences[index] = 0;
    mesh.morphTargetInfluences = influences;
    geometry.computeBoundingBox?.();
    geometry.computeBoundingSphere?.();
    return index;
  }

  private applyMaterial(mesh: Mesh, config: MaterialConfig) {
    if (typeof config.renderOrder === 'number') mesh.renderOrder = config.renderOrder;
    for (const material of materials((mesh as any).material) as any[]) {
      if (typeof config.opacity === 'number') material.opacity = config.opacity;
      if (typeof config.transparent === 'boolean') material.transparent = config.transparent;
      else if (typeof config.opacity === 'number' && config.opacity < 1) material.transparent = true;
      if (typeof config.depthWrite === 'boolean') material.depthWrite = config.depthWrite;
      if (typeof config.depthTest === 'boolean') material.depthTest = config.depthTest;
      if (config.blending) material.blending = THREE_BLENDING_MODES[config.blending];
      material.needsUpdate = true;
    }
  }

  private visitMesh(root: Object3D, name: string, visit: (mesh: Mesh) => void) {
    root.traverse((object: any) => { if (object.isMesh && object.name === name) visit(object); });
  }
}

export const collectMorphMeshes = (root: Object3D) => {
  const meshes: Mesh[] = [];
  root.traverse((object: any) => { if (object.isMesh && morphEntries(object).length > 0) meshes.push(object); });
  return meshes;
};

export * from './model';
export * from './scene';
