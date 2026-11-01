import * as THREE from 'three';
import { requireInitializedEmbodyCore } from '@lovelace_lol/embody/wasm';
import type { AnnotationAnchoredRegion, RuntimeAnnotationSide } from './types';
import { annotationQuery } from './runtime';
import { readMorphGeometry, sampleMorphVertices, updateAnnotationWorldMatrices } from './morphGeometry';
export function getRuntimeAnnotationSide(region: AnnotationAnchoredRegion): RuntimeAnnotationSide | null { return annotationQuery('side', { region }); }
export function getRuntimeAUMeshSideOffset(region: AnnotationAnchoredRegion, sideSign: number, modelSize: THREE.Vector3): THREE.Vector3 | null { const value = annotationQuery<{x:number;y:number;z:number} | null>('meshSideOffset', { region, sideSign, size: modelSize }); return value ? new THREE.Vector3(value.x, value.y, value.z) : null; }
/** Reads native attributes; both candidate selection and anchor reduction run in Rust. */
export function getRuntimeAUMorphAnchorPoint(region: AnnotationAnchoredRegion, mesh: THREE.Mesh): THREE.Vector3 | null {
  const core = requireInitializedEmbodyCore();
  const names = annotationQuery<string[]>('morphNames', { region });
  const geometry = readMorphGeometry(mesh, names);
  if (!geometry) return null;
  const candidates = core.annotation_morph_anchor_candidates(JSON.stringify(region), geometry.base, geometry.morphs, geometry.relative);
  updateAnnotationWorldMatrices(mesh);
  const positions = new Float32Array(candidates.length / 2 * 3);
  sampleMorphVertices(mesh, candidates.filter((_value, index) => index % 2 === 0), positions);
  const samples = new Float32Array(candidates.length / 2 * 4);
  for (let index = 0; index < candidates.length / 2; index++) {
    samples.set(positions.subarray(index * 3, index * 3 + 3), index * 4);
    samples[index * 4 + 3] = candidates[index * 2 + 1];
  }
  const value = core.annotation_weighted_anchor(samples);
  return value.length === 3 ? new THREE.Vector3().fromArray(value) : null;
}
