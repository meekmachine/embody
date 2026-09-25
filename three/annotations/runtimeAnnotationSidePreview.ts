import * as THREE from 'three';
import type { AnnotationAnchoredRegion, RuntimeAnnotationSide } from './types';

const MORPH_ANCHOR_DELTA_EPSILON = 1e-5;
const MORPH_ANCHOR_CANDIDATE_DELTA_RATIO = 0.06;
const MORPH_ANCHOR_SIGNIFICANT_DELTA_RATIO = 0.18;
const MORPH_ANCHOR_MIN_SEMANTIC_CANDIDATES = 2;

type MorphAnchorCandidate = {
  point: THREE.Vector3;
  magnitude: number;
};

type MorphAnchorVerticalBand = {
  min: number;
  max: number;
};

export function getRuntimeAnnotationSide(region: AnnotationAnchoredRegion): RuntimeAnnotationSide | null {
  const side = region.runtimeAnnotation?.side;
  return side === 'left' || side === 'right' || side === 'center' ? side : null;
}

function getMorphPositionAttribute(
  mesh: THREE.Mesh,
  morphName: string,
): THREE.BufferAttribute | THREE.InterleavedBufferAttribute | null {
  const morphIndex = mesh.morphTargetDictionary?.[morphName];
  if (morphIndex == null) return null;

  const morphPositions = mesh.geometry.morphAttributes.position;
  return morphPositions?.[morphIndex] ?? null;
}

function getMorphDeltaMagnitudeAtIndex(
  mesh: THREE.Mesh,
  basePositions: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  morphAttribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  index: number,
): number {
  const relative = mesh.geometry.morphTargetsRelative;
  const dx = morphAttribute.getX(index) - (relative ? 0 : basePositions.getX(index));
  const dy = morphAttribute.getY(index) - (relative ? 0 : basePositions.getY(index));
  const dz = morphAttribute.getZ(index) - (relative ? 0 : basePositions.getZ(index));
  return Math.hypot(dx, dy, dz);
}

function getRuntimeAnnotationSearchText(region: AnnotationAnchoredRegion): string {
  return [
    region.name,
    region.label,
    ...(region.runtimeAnnotation?.morphNames ?? []),
  ].join(' ').toLowerCase();
}

function resolveMorphAnchorVerticalBand(region: AnnotationAnchoredRegion): MorphAnchorVerticalBand | null {
  const text = getRuntimeAnnotationSearchText(region);

  if (/brow|forehead|frontalis/.test(text)) {
    return { min: 0.75, max: 1 };
  }
  if (/eye|lid|blink|squint|wide|occlusion|tearline/.test(text)) {
    return { min: 0.45, max: 0.9 };
  }
  if (/nose|nasal|sneer/.test(text)) {
    return { min: 0.35, max: 0.8 };
  }
  if (/cheek/.test(text)) {
    return { min: 0.45, max: 0.9 };
  }
  if (/jaw|chin/.test(text)) {
    return { min: 0, max: 0.3 };
  }
  if (/mouth|lip|smile|frown|dimple|pucker|stretch|press|funnel|roll|shrug|close/.test(text)) {
    return { min: 0, max: 0.45 };
  }
  if (/tongue/.test(text)) {
    return { min: 0, max: 0.5 };
  }

  return null;
}

function getQuantile(sortedValues: number[], ratio: number): number | null {
  if (sortedValues.length === 0) return null;
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.floor((sortedValues.length - 1) * ratio)),
  );
  return sortedValues[index] ?? null;
}

function selectSemanticMorphAnchorCandidates(
  region: AnnotationAnchoredRegion,
  candidates: MorphAnchorCandidate[],
): MorphAnchorCandidate[] | null {
  const band = resolveMorphAnchorVerticalBand(region);
  if (!band || candidates.length < MORPH_ANCHOR_MIN_SEMANTIC_CANDIDATES) {
    return null;
  }

  const sortedY = candidates
    .map((candidate) => candidate.point.y)
    .sort((a, b) => a - b);
  const minY = getQuantile(sortedY, band.min);
  const maxY = getQuantile(sortedY, band.max);
  if (minY == null || maxY == null) return null;

  const selected = candidates.filter((candidate) =>
    candidate.point.y >= minY - MORPH_ANCHOR_DELTA_EPSILON &&
    candidate.point.y <= maxY + MORPH_ANCHOR_DELTA_EPSILON
  );

  return selected.length >= MORPH_ANCHOR_MIN_SEMANTIC_CANDIDATES ? selected : null;
}

function getWeightedMorphAnchorCenter(candidates: MorphAnchorCandidate[]): THREE.Vector3 | null {
  const weightedCenter = new THREE.Vector3();
  let totalWeight = 0;

  for (const candidate of candidates) {
    weightedCenter.addScaledVector(candidate.point, candidate.magnitude);
    totalWeight += candidate.magnitude;
  }

  return totalWeight > 0
    ? weightedCenter.multiplyScalar(1 / totalWeight)
    : null;
}

export function getRuntimeAUMorphAnchorPoint(
  region: AnnotationAnchoredRegion,
  mesh: THREE.Mesh,
): THREE.Vector3 | null {
  const runtimeAnnotation = region.runtimeAnnotation;
  const morphNames = runtimeAnnotation?.morphNames;
  if (
    runtimeAnnotation?.targetType !== 'au' ||
    !Array.isArray(morphNames) ||
    morphNames.length === 0
  ) {
    return null;
  }

  const basePositions = mesh.geometry.getAttribute('position');
  if (!basePositions) return null;

  const morphAttributes = morphNames
    .map((morphName) => getMorphPositionAttribute(mesh, morphName))
    .filter((attribute): attribute is THREE.BufferAttribute | THREE.InterleavedBufferAttribute => Boolean(attribute));

  if (morphAttributes.length === 0) return null;

  const vertexCount = basePositions.count;
  const magnitudes = new Float32Array(vertexCount);
  let maxMagnitude = 0;

  for (const morphAttribute of morphAttributes) {
    for (let index = 0; index < vertexCount; index += 1) {
      const magnitude = getMorphDeltaMagnitudeAtIndex(mesh, basePositions, morphAttribute, index);
      if (magnitude <= magnitudes[index]) continue;

      magnitudes[index] = magnitude;
      maxMagnitude = Math.max(maxMagnitude, magnitude);
    }
  }

  if (maxMagnitude <= MORPH_ANCHOR_DELTA_EPSILON) return null;

  const significantThreshold = Math.max(
    MORPH_ANCHOR_DELTA_EPSILON,
    maxMagnitude * MORPH_ANCHOR_SIGNIFICANT_DELTA_RATIO,
  );
  const candidateThreshold = Math.max(
    MORPH_ANCHOR_DELTA_EPSILON,
    maxMagnitude * MORPH_ANCHOR_CANDIDATE_DELTA_RATIO,
  );
  const skinnedMesh = mesh as THREE.SkinnedMesh;
  mesh.updateWorldMatrix(true, false);
  if (skinnedMesh.isSkinnedMesh && skinnedMesh.skeleton) {
    skinnedMesh.skeleton.update();
  }

  const vertex = new THREE.Vector3();
  const candidates: MorphAnchorCandidate[] = [];
  const fallbackCandidates: MorphAnchorCandidate[] = [];
  let strongestIndex = -1;
  let strongestMagnitude = 0;

  for (let index = 0; index < vertexCount; index += 1) {
    const magnitude = magnitudes[index] ?? 0;
    if (magnitude > strongestMagnitude) {
      strongestMagnitude = magnitude;
      strongestIndex = index;
    }
    if (magnitude < candidateThreshold) continue;

    mesh.getVertexPosition(index, vertex);
    vertex.applyMatrix4(mesh.matrixWorld);
    const candidate = {
      point: vertex.clone(),
      magnitude,
    };
    candidates.push(candidate);
    if (magnitude >= significantThreshold) {
      fallbackCandidates.push(candidate);
    }
  }

  const selectedCandidates = selectSemanticMorphAnchorCandidates(region, candidates)
    ?? (fallbackCandidates.length > 0 ? fallbackCandidates : candidates);
  const weightedCenter = getWeightedMorphAnchorCenter(selectedCandidates);
  if (weightedCenter) return weightedCenter;

  if (strongestIndex < 0) return null;
  mesh.getVertexPosition(strongestIndex, vertex);
  return vertex.applyMatrix4(mesh.matrixWorld).clone();
}

export function getRuntimeAUMeshSideOffset(
  region: AnnotationAnchoredRegion,
  sideSign: number,
  modelSize: THREE.Vector3,
): THREE.Vector3 | null {
  const side = getRuntimeAnnotationSide(region);
  if (
    region.runtimeAnnotation?.targetType !== 'au' ||
    (side !== 'left' && side !== 'right')
  ) {
    return null;
  }

  const height = modelSize.y || 1;
  const width = modelSize.x || height * 0.35;
  const depth = modelSize.z || height * 0.25;
  const text = [
    region.name,
    region.label,
    ...(region.runtimeAnnotation.morphNames ?? []),
  ].join(' ').toLowerCase();

  const horizontalOffset = Math.max(
    Math.min(width * 0.18, height * 0.08),
    height * 0.035,
  );
  const depthOffset = Math.max(depth * 0.08, height * 0.025);
  let verticalOffset = height * 0.02;

  if (/brow|forehead|frontalis|eye|lid|blink|squint/.test(text)) {
    verticalOffset = height * 0.1;
  } else if (/nose|cheek|nasal/.test(text)) {
    verticalOffset = height * 0.04;
  } else if (/mouth|lip|smile|frown|jaw|chin|dimple|pucker|stretch/.test(text)) {
    verticalOffset = -height * 0.06;
  }

  return new THREE.Vector3(
    sideSign * horizontalOffset,
    verticalOffset,
    depthOffset,
  );
}
