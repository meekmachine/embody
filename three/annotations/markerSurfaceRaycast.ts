import type * as THREE from 'three';

const SLICE_BUDGET_MS = 4;

/**
 * Keep Three's native per-mesh raycast, including skinning, morphs and material
 * sides. Yield between meshes once a slice is spent; one mesh is indivisible.
 * A null result means the owning model/region load was replaced or disposed.
 */
export async function intersectMeshesInSlices(
  raycaster: THREE.Raycaster,
  meshes: readonly THREE.Mesh[],
  options: { isCurrent: () => boolean; yieldToPaint: () => Promise<void>; now?: () => number },
): Promise<THREE.Intersection[] | null> {
  const now = options.now ?? (() => performance.now());
  let sliceStart = now();
  const hits: THREE.Intersection[] = [];
  for (const [index, mesh] of meshes.entries()) {
    if (!options.isCurrent()) return null;
    // Let Raycaster apply its native layer checks and Mesh/SkinnedMesh logic.
    // Accumulate separately so earlier meshes' hits aren't sorted repeatedly.
    for (const hit of raycaster.intersectObject(mesh, false)) hits.push(hit);
    if (!options.isCurrent()) return null;
    if (index < meshes.length - 1 && now() - sliceStart >= SLICE_BUDGET_MS) {
      await options.yieldToPaint();
      if (!options.isCurrent()) return null;
      sliceStart = now();
    }
  }
  if (!options.isCurrent()) return null;
  // Same stable distance ordering as Raycaster.intersectObjects(meshes, false).
  return hits.sort((left, right) => left.distance - right.distance);
}
