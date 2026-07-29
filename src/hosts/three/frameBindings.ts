import type { Mesh, Object3D } from 'three';
import type { BoneId, MeshId, MorphTargetId } from '../../core/contracts';
import type { ThreeFrameApplierBindings } from '../../engines/three/ThreeFrameApplier';
import type { ThreeModelInspection } from '../../engines/three/ThreeModelInspector';

/**
 * Build ThreeFrameApplier bindings from a model inspection.
 * Lives in the Three host package so thin hosts never import Embody.ts.
 */
export function buildFrameApplierBindings(
  inspection: ThreeModelInspection,
): ThreeFrameApplierBindings {
  const meshes = new Map<MeshId, Mesh>();
  for (const meshDesc of inspection.descriptor.meshes) {
    const mesh = inspection.meshByName.get(meshDesc.name)
      || inspection.allMeshes.find((candidate) => candidate.name === meshDesc.name);
    if (mesh) {
      meshes.set(meshDesc.id, mesh);
    }
  }

  const morphTargets = new Map<
    MorphTargetId,
    { meshId: MeshId; mesh: Mesh; index: number }
  >();
  for (const morph of inspection.descriptor.morphTargets) {
    const mesh = meshes.get(morph.meshId);
    if (!mesh || morph.hostIndex === undefined) continue;
    morphTargets.set(morph.id, {
      meshId: morph.meshId,
      mesh,
      index: morph.hostIndex,
    });
  }

  const bonesByName = new Map<string, Object3D>();
  for (const entry of Object.values(inspection.bones)) {
    if (entry?.obj?.name) {
      bonesByName.set(entry.obj.name, entry.obj);
    }
  }
  if (inspection.allMeshes[0]?.parent) {
    let root: Object3D | null = inspection.allMeshes[0];
    while (root?.parent) root = root.parent;
    root?.traverse((obj) => {
      if (obj.name && !bonesByName.has(obj.name)) {
        bonesByName.set(obj.name, obj);
      }
    });
  }

  const bones = new Map<BoneId, Object3D>();
  for (const boneDesc of inspection.descriptor.bones) {
    const bone = bonesByName.get(boneDesc.name);
    if (bone) {
      bones.set(boneDesc.id, bone);
    }
  }

  return { meshes, morphTargets, bones };
}
