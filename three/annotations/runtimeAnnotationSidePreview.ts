import * as THREE from 'three';
import { requireInitializedEmbodyCore } from '@lovelace_lol/embody/wasm';
import type { AnnotationAnchoredRegion, RuntimeAnnotationSide } from './types';
import { annotationQuery } from './runtime';
import { readAttribute } from './modelObservation';
export function getRuntimeAnnotationSide(region: AnnotationAnchoredRegion): RuntimeAnnotationSide | null { return annotationQuery('side', { region }); }
export function getRuntimeAUMeshSideOffset(region: AnnotationAnchoredRegion, sideSign: number, modelSize: THREE.Vector3): THREE.Vector3 | null { const value = annotationQuery<{x:number;y:number;z:number} | null>('meshSideOffset', { region, sideSign, size: modelSize }); return value ? new THREE.Vector3(value.x, value.y, value.z) : null; }
/** Reads native attributes; both candidate selection and anchor reduction run in Rust. */
export function getRuntimeAUMorphAnchorPoint(region: AnnotationAnchoredRegion, mesh: THREE.Mesh): THREE.Vector3 | null {
  const core = requireInitializedEmbodyCore();
  const names = annotationQuery<string[]>('morphNames', { region });
  const positions = mesh.geometry.getAttribute('position');
  if (!positions) return null;
  const attributes = names.flatMap(name => { const index = mesh.morphTargetDictionary?.[name]; const attribute = index == null ? undefined : mesh.geometry.morphAttributes.position?.[index]; return attribute ? [attribute] : []; });
  const base = readAttribute(positions);
  const morphs = new Float32Array(attributes.length * base.length);
  attributes.forEach((attribute, index) => morphs.set(readAttribute(attribute), index * base.length));
  const candidates = core.annotation_morph_candidates(base, morphs, mesh.geometry.morphTargetsRelative);
  mesh.updateWorldMatrix(true, false);
  const skinned = mesh as THREE.SkinnedMesh;
  if (skinned.isSkinnedMesh) skinned.skeleton.update();
  const samples = new Float32Array(candidates.length / 2 * 4);
  const vertex = new THREE.Vector3();
  for (let offset = 0; offset < candidates.length; offset += 2) { mesh.getVertexPosition(candidates[offset], vertex).applyMatrix4(mesh.matrixWorld); samples.set([vertex.x, vertex.y, vertex.z, candidates[offset + 1]], offset * 2); }
  const value = core.annotation_morph_center(JSON.stringify(region), samples);
  return value.length === 3 ? new THREE.Vector3().fromArray(value) : null;
}
