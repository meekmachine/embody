import { Float32BufferAttribute, FloatType } from 'three';
import type { BufferAttribute, BufferGeometry, InterleavedBufferAttribute, Object3D, SkinnedMesh } from 'three';

/** Keep joint indices compatible with both native WebGPU and WebGL skinning. */
export function prepareModelSkinning(model: Object3D): () => void {
  const replacements: { geometry: BufferGeometry; original: BufferAttribute | InterleavedBufferAttribute; prepared: BufferAttribute }[] = [];
  model.traverse(object => {
    const mesh = object as SkinnedMesh;
    if (!mesh.isSkinnedMesh) return;
    const geometry = mesh.geometry;
    const original = geometry.getAttribute('skinIndex');
    if (!original) return;
    if (original.array instanceof Float32Array && (!('gpuType' in original) || original.gpuType === FloatType)) return;

    // Three's native backend widens Uint8/Uint16 attributes in place to Uint32.
    // WebGL then uses vertexAttribIPointer, but its skinIndex shader input is
    // vec4. Float32 preserves every glTF joint index and avoids that mutation.
    // Read components so interleaved indices do not copy adjacent attributes.
    const prepared = new Float32BufferAttribute(original.count * original.itemSize, original.itemSize);
    for (let vertex = 0; vertex < original.count; vertex++) {
      for (let component = 0; component < original.itemSize; component++) {
        prepared.setComponent(vertex, component, original.getComponent(vertex, component));
      }
    }
    prepared.name = original.name;
    prepared.setUsage('data' in original ? original.data.usage : original.usage);
    geometry.setAttribute('skinIndex', prepared);
    replacements.push({ geometry, original, prepared });
  });
  // A replacement renderer may fail after compilation. The old native pipeline
  // still expects its original attribute format, so restore its exact objects.
  return () => {
    for (const { geometry, original, prepared } of replacements) {
      if (geometry.getAttribute('skinIndex') === prepared) geometry.setAttribute('skinIndex', original);
    }
  };
}
