import {
  AdditiveBlending,
  MultiplyBlending,
  NoBlending,
  NormalBlending,
  Quaternion,
  SubtractiveBlending,
  Vector3,
} from 'three';
import type { Material, Mesh, Object3D } from 'three';
import type {
  BoneId,
  FrameDelta,
  HostFrameApplier,
  MeshId,
  MorphTargetId,
  Quat,
  Transform,
  Vec3,
} from '../../core/contracts';

export interface ThreeMorphTargetBinding {
  readonly meshId: MeshId;
  readonly mesh: Mesh;
  readonly index: number;
}

export interface ThreeFrameApplierBindings {
  readonly meshes?: ReadonlyMap<MeshId, Mesh>;
  readonly morphTargets?: ReadonlyMap<MorphTargetId, ThreeMorphTargetBinding>;
  readonly bones?: ReadonlyMap<BoneId, Object3D>;
}

export interface ThreeMaterialConfig {
  renderOrder?: number;
  transparent?: boolean;
  opacity?: number;
  depthWrite?: boolean;
  depthTest?: boolean;
  blending?: keyof typeof THREE_BLENDING_MODES;
}

export interface ThreeResolvedMaterialConfig {
  renderOrder: number;
  transparent: boolean;
  opacity: number;
  depthWrite: boolean;
  depthTest: boolean;
  blending: keyof typeof THREE_BLENDING_MODES;
}

export const THREE_BLENDING_MODES = {
  Normal: NormalBlending,
  Additive: AdditiveBlending,
  Subtractive: SubtractiveBlending,
  Multiply: MultiplyBlending,
  None: NoBlending,
} as const;

export class ThreeFrameApplier implements HostFrameApplier<Object3D> {
  private meshes = new Map<MeshId, Mesh>();
  private morphTargets = new Map<MorphTargetId, ThreeMorphTargetBinding>();
  private bones = new Map<BoneId, Object3D>();
  private originalEmissive = new Map<string, { color: number; intensity: number }>();

  constructor(bindings: ThreeFrameApplierBindings = {}) {
    this.setBindings(bindings);
  }

  setBindings(bindings: ThreeFrameApplierBindings): void {
    this.meshes = new Map(bindings.meshes || []);
    this.morphTargets = new Map(bindings.morphTargets || []);
    this.bones = new Map(bindings.bones || []);
  }

  applyFrameDelta(model: Object3D, frame: FrameDelta): void {
    for (const write of frame.morphTargets || []) {
      const binding = this.morphTargets.get(write.morphTargetId);
      if (!binding) continue;
      this.setMorphTarget(binding, write.value, write.mode);
    }

    for (const write of frame.bones || []) {
      const bone = this.bones.get(write.boneId);
      if (!bone) continue;
      this.applyTransform(bone, write.transform, write.mode);
    }

    for (const write of frame.meshes || []) {
      const mesh = this.meshes.get(write.meshId);
      if (!mesh) continue;
      if (typeof write.visible === 'boolean') {
        mesh.visible = write.visible;
      }
    }

    model.updateMatrixWorld(true);
  }

  applyPackedMorphFrameDelta(values: ArrayLike<number>, stride = 4): void {
    for (let index = 0; index + stride <= values.length; index += stride) {
      const morphTargetId = values[index + 1] as MorphTargetId;
      const binding = this.morphTargets.get(morphTargetId);
      if (!binding) continue;
      const mode = (values[index + 3] ?? 0) === 1 ? 'additive' : 'absolute';
      this.setMorphTarget(binding, values[index + 2] ?? 0, mode);
    }
  }

  applyObjectTransform(
    target: Object3D,
    transform: Transform,
    mode: 'absolute' | 'additive' = 'absolute'
  ): void {
    this.applyTransform(target, transform, mode);
  }

  applyMorphTargets(targets: readonly { infl: number[]; idx: number }[], value: number): void {
    for (const target of targets) {
      if (target.idx >= 0 && target.idx < target.infl.length) {
        target.infl[target.idx] = value;
      }
    }
  }

  resetMorphTargets(targets: readonly { infl: number[]; idx: number }[]): void {
    this.applyMorphTargets(targets, 0);
  }

  setMeshVisible(root: Object3D, meshName: string, visible: boolean): void {
    this.visitNamedMesh(root, meshName, (mesh) => {
      mesh.visible = visible;
    });
  }

  highlightMesh(root: Object3D, meshName: string | null, color = 0x00ffff, intensity = 0.5): void {
    root.traverse((obj: any) => {
      if (!obj.isMesh) return;

      for (const material of getMaterials(obj.material)) {
        if (!hasEmissive(material)) continue;

        if (meshName === null || obj.name !== meshName) {
          const original = this.originalEmissive.get(obj.name);
          if (original) {
            material.emissive.setHex(original.color);
            material.emissiveIntensity = original.intensity;
          }
          continue;
        }

        if (!this.originalEmissive.has(obj.name)) {
          this.originalEmissive.set(obj.name, {
            color: material.emissive.getHex(),
            intensity: material.emissiveIntensity || 0,
          });
        }
        material.emissive.setHex(color);
        material.emissiveIntensity = intensity;
      }
    });
  }

  getMeshMaterialConfig(root: Object3D, meshName: string): ThreeResolvedMaterialConfig | null {
    let result: ThreeResolvedMaterialConfig | null = null;
    this.visitNamedMesh(root, meshName, (mesh) => {
      const material = getMaterials((mesh as any).material)[0];
      if (!material) return;
      result = {
        renderOrder: mesh.renderOrder,
        transparent: material.transparent,
        opacity: material.opacity,
        depthWrite: material.depthWrite,
        depthTest: material.depthTest,
        blending: getBlendingName(material.blending),
      };
    });
    return result;
  }

  setMeshMaterialConfig(root: Object3D, meshName: string, config: ThreeMaterialConfig): void {
    this.visitNamedMesh(root, meshName, (mesh) => {
      if (typeof config.renderOrder === 'number') {
        mesh.renderOrder = config.renderOrder;
      }

      for (const material of getMaterials((mesh as any).material)) {
        if (typeof config.opacity === 'number') {
          material.opacity = config.opacity;
          if (config.opacity < 1 && config.transparent === undefined) {
            material.transparent = true;
          }
        }
        if (typeof config.transparent === 'boolean') {
          material.transparent = config.transparent;
        }
        if (typeof config.depthWrite === 'boolean') {
          material.depthWrite = config.depthWrite;
        }
        if (typeof config.depthTest === 'boolean') {
          material.depthTest = config.depthTest;
        }
        if (config.blending && config.blending in THREE_BLENDING_MODES) {
          material.blending = THREE_BLENDING_MODES[config.blending];
        }
        material.needsUpdate = true;
      }
    });
  }

  private setMorphTarget(
    binding: ThreeMorphTargetBinding,
    value: number,
    mode: 'absolute' | 'additive' = 'absolute'
  ): void {
    const influences = binding.mesh.morphTargetInfluences;
    if (!influences || binding.index < 0 || binding.index >= influences.length) {
      return;
    }
    influences[binding.index] = mode === 'additive'
      ? (influences[binding.index] ?? 0) + value
      : value;
  }

  private applyTransform(
    target: Object3D,
    transform: Transform,
    mode: 'absolute' | 'additive' = 'absolute'
  ): void {
    if (transform.position) {
      applyVec3(target.position, transform.position, mode);
    }
    if (transform.rotation) {
      applyQuat(target.quaternion, transform.rotation, mode);
    }
    if (transform.scale) {
      applyVec3(target.scale, transform.scale, mode);
    }
    target.updateMatrixWorld(false);
  }

  private visitNamedMesh(root: Object3D, meshName: string, visit: (mesh: Mesh) => void): void {
    root.traverse((obj: any) => {
      if (obj.isMesh && obj.name === meshName) {
        visit(obj as Mesh);
      }
    });
  }
}

function applyVec3(target: Vector3, value: Vec3, mode: 'absolute' | 'additive'): void {
  if (mode === 'additive') {
    target.x += value.x;
    target.y += value.y;
    target.z += value.z;
    return;
  }
  target.set(value.x, value.y, value.z);
}

function applyQuat(target: Quaternion, value: Quat, mode: 'absolute' | 'additive'): void {
  const next = new Quaternion(value.x, value.y, value.z, value.w).normalize();
  if (mode === 'additive') {
    target.multiply(next);
    return;
  }
  target.copy(next);
}

function getMaterials(material: Material | Material[] | undefined): Material[] {
  if (!material) return [];
  return Array.isArray(material) ? material : [material];
}

function hasEmissive(material: Material): material is Material & {
  emissive: { getHex(): number; setHex(color: number): void };
  emissiveIntensity: number;
} {
  return 'emissive' in material;
}

function getBlendingName(value: number): keyof typeof THREE_BLENDING_MODES {
  for (const [name, blending] of Object.entries(THREE_BLENDING_MODES)) {
    if (blending === value) {
      return name as keyof typeof THREE_BLENDING_MODES;
    }
  }
  return 'Normal';
}
