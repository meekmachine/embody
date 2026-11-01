import * as THREE from 'three';

type Attribute = THREE.BufferAttribute | THREE.InterleavedBufferAttribute;

export function readAttribute(attribute: Attribute): Float32Array {
  const values = new Float32Array(attribute.count * attribute.itemSize);
  for (let index = 0; index < attribute.count; index++) for (let axis = 0; axis < attribute.itemSize; axis++) values[index * attribute.itemSize + axis] = attribute.getComponent(index, axis);
  return values;
}

export function readMorphGeometry(mesh: THREE.Mesh, names: string[]): { base: Float32Array; morphs: Float32Array; relative: boolean } | null {
  const position = mesh.geometry.getAttribute('position');
  if (!position || position.itemSize !== 3) return null;
  const attributes = names.flatMap(name => {
    const index = mesh.morphTargetDictionary?.[name];
    const attribute = index == null ? undefined : mesh.geometry.morphAttributes.position?.[index];
    return attribute ? [attribute] : [];
  });
  if (!attributes.length || attributes.some(attribute => attribute.count !== position.count || attribute.itemSize !== 3)) return null;
  const base = readAttribute(position);
  const morphs = new Float32Array(attributes.length * base.length);
  attributes.forEach((attribute, index) => morphs.set(readAttribute(attribute), index * base.length));
  return { base, morphs, relative: mesh.geometry.morphTargetsRelative };
}

export function updateAnnotationWorldMatrices(model: THREE.Object3D): void {
  model.parent?.updateWorldMatrix(true, false);
  // SkinnedMesh updates its bind inverse in this override, before CPU skinning.
  model.updateMatrixWorld(true);
}

export function sampleMorphVertices(mesh: THREE.Mesh, indices: ArrayLike<number>, samples: Float32Array, vertex = new THREE.Vector3()): void {
  const skinned = mesh as THREE.SkinnedMesh;
  if (skinned.isSkinnedMesh) {
    // Skeleton bones may be siblings of the mesh, outside its updated subtree.
    for (const bone of skinned.skeleton.bones) bone.updateWorldMatrix(true, false);
    skinned.skeleton.update();
  }
  for (let offset = 0; offset < indices.length; offset++) {
    mesh.getVertexPosition(indices[offset], vertex).applyMatrix4(mesh.matrixWorld);
    samples[offset * 3] = vertex.x;
    samples[offset * 3 + 1] = vertex.y;
    samples[offset * 3 + 2] = vertex.z;
  }
}

/** Native identities/versions only. Rust decides whether this observation
 * invalidates an attachment and which geometry/vertices are needed next. */
export class MorphGeometryObservation {
  revision = 0;
  namesJson = '[]';
  private signature: unknown[] = [];
  observe(mesh: THREE.Mesh): void {
    const dictionary = Object.entries(mesh.morphTargetDictionary ?? {}).sort(([a], [b]) => a.localeCompare(b));
    const attributes = [mesh.geometry.getAttribute('position'), ...(mesh.geometry.morphAttributes.position ?? [])];
    const signature: unknown[] = [mesh.geometry, mesh.geometry.morphTargetsRelative, ...dictionary.flat()];
    for (const attribute of attributes) {
      signature.push(attribute);
      if (attribute) signature.push(attribute.array, attribute.count, attribute.itemSize, attribute.normalized,
        'data' in attribute ? attribute.data.version : attribute.version,
        'data' in attribute ? attribute.data.stride : 0, 'offset' in attribute ? attribute.offset : 0);
    }
    if (signature.length === this.signature.length && signature.every((value, index) => value === this.signature[index])) return;
    this.signature = signature;
    this.revision++;
    this.namesJson = JSON.stringify(dictionary.map(([name]) => name));
  }
}
