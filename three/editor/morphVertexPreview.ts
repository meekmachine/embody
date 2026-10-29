import * as THREE from 'three';

const DEFAULT_THRESHOLD = 1e-4;
const DEFAULT_MAX_POINTS = 12000;

const COLOR_LOW = { r: 1.0, g: 0.78, b: 0.28 };
const COLOR_HIGH = { r: 1.0, g: 0.36, b: 0.16 };

export interface MorphVertexPreviewOptions {
  threshold?: number;
  maxPoints?: number;
}

export interface MorphVertexPreviewSample {
  indices: Uint32Array;
  intensities: Float32Array;
}

export interface MorphVertexPreviewRenderData {
  positions: Float32Array;
  colors: Float32Array;
  pointCount: number;
  meshCount: number;
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

function getDeltaMagnitudeAtIndex(
  mesh: THREE.Mesh,
  morphAttribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  index: number,
): number {
  const geometry = mesh.geometry;
  const relative = geometry.morphTargetsRelative;
  const basePositions = geometry.getAttribute('position');
  if (!basePositions) return 0;

  const dx = morphAttribute.getX(index) - (relative ? 0 : basePositions.getX(index));
  const dy = morphAttribute.getY(index) - (relative ? 0 : basePositions.getY(index));
  const dz = morphAttribute.getZ(index) - (relative ? 0 : basePositions.getZ(index));
  return Math.hypot(dx, dy, dz);
}

export function resolveMorphPreviewMeshes(
  root: THREE.Object3D,
  morphName: string,
  meshNames?: string[],
): THREE.Mesh[] {
  const nameFilter = meshNames ? new Set(meshNames) : null;
  const meshes: THREE.Mesh[] = [];

  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (nameFilter && !nameFilter.has(mesh.name)) return;
    if (mesh.morphTargetDictionary?.[morphName] == null) return;
    meshes.push(mesh);
  });

  return meshes;
}

export function buildMorphVertexPreviewSample(
  mesh: THREE.Mesh,
  morphName: string,
  options: MorphVertexPreviewOptions = {},
): MorphVertexPreviewSample | null {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const maxPoints = options.maxPoints ?? DEFAULT_MAX_POINTS;
  const morphAttribute = getMorphPositionAttribute(mesh, morphName);
  if (!morphAttribute) return null;

  const candidateIndices: number[] = [];
  const magnitudes: number[] = [];

  for (let index = 0; index < morphAttribute.count; index += 1) {
    const magnitude = getDeltaMagnitudeAtIndex(mesh, morphAttribute, index);
    if (magnitude <= threshold) continue;
    candidateIndices.push(index);
    magnitudes.push(magnitude);
  }

  if (candidateIndices.length === 0) return null;

  const stride = candidateIndices.length > maxPoints ? Math.ceil(candidateIndices.length / maxPoints) : 1;
  const sampleCount = Math.ceil(candidateIndices.length / stride);
  const indices = new Uint32Array(sampleCount);
  const intensities = new Float32Array(sampleCount);

  let maxMagnitude = 0;
  let cursor = 0;
  for (let i = 0; i < candidateIndices.length; i += stride) {
    const magnitude = magnitudes[i] ?? 0;
    indices[cursor] = candidateIndices[i] ?? 0;
    intensities[cursor] = magnitude;
    maxMagnitude = Math.max(maxMagnitude, magnitude);
    cursor += 1;
  }

  const normalizer = maxMagnitude > 0 ? 1 / maxMagnitude : 1;
  for (let i = 0; i < intensities.length; i += 1) {
    intensities[i] *= normalizer;
  }

  return { indices, intensities };
}

function writePointColor(colors: Float32Array, offset: number, intensity: number): void {
  colors[offset] = COLOR_LOW.r + (COLOR_HIGH.r - COLOR_LOW.r) * intensity;
  colors[offset + 1] = COLOR_LOW.g + (COLOR_HIGH.g - COLOR_LOW.g) * intensity;
  colors[offset + 2] = COLOR_LOW.b + (COLOR_HIGH.b - COLOR_LOW.b) * intensity;
}

export function buildMorphVertexPreviewRenderData(
  meshes: THREE.Mesh[],
  morphName: string,
  cache: Map<string, MorphVertexPreviewSample>,
  options: MorphVertexPreviewOptions = {},
  previous: MorphVertexPreviewRenderData | null = null,
): MorphVertexPreviewRenderData | null {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const maxPoints = options.maxPoints ?? DEFAULT_MAX_POINTS;
  const sampledMeshes: Array<{ mesh: THREE.Mesh; sample: MorphVertexPreviewSample }> = [];
  let pointCount = 0;

  for (const mesh of meshes) {
    const cacheKey = `${mesh.uuid}:${morphName}:${threshold}:${maxPoints}`;
    let sample = cache.get(cacheKey) ?? null;
    if (!sample) {
      sample = buildMorphVertexPreviewSample(mesh, morphName, { threshold, maxPoints });
      if (sample) cache.set(cacheKey, sample);
    }
    if (!sample) continue;
    sampledMeshes.push({ mesh, sample });
    pointCount += sample.indices.length;
  }

  if (pointCount === 0) return null;

  const positions = previous?.positions.length === pointCount * 3
    ? previous.positions : new Float32Array(pointCount * 3);
  const colors = previous?.colors.length === pointCount * 3
    ? previous.colors : new Float32Array(pointCount * 3);
  const vertex = new THREE.Vector3();
  let cursor = 0;

  for (const { mesh, sample } of sampledMeshes) {
    mesh.updateWorldMatrix(true, false);
    const skinnedMesh = mesh as THREE.SkinnedMesh;
    if (skinnedMesh.isSkinnedMesh && skinnedMesh.skeleton) {
      skinnedMesh.skeleton.update();
    }

    for (let i = 0; i < sample.indices.length; i += 1) {
      mesh.getVertexPosition(sample.indices[i] ?? 0, vertex);
      vertex.applyMatrix4(mesh.matrixWorld);

      const offset = cursor * 3;
      positions[offset] = vertex.x;
      positions[offset + 1] = vertex.y;
      positions[offset + 2] = vertex.z;
      writePointColor(colors, offset, sample.intensities[i] ?? 0);
      cursor += 1;
    }
  }

  return {
    positions,
    colors,
    pointCount,
    meshCount: sampledMeshes.length,
  };
}

type PreviewRenderBinding = {
  callbacks: Set<() => void>;
  previous: THREE.Scene['onBeforeRender'];
  render: THREE.Scene['onBeforeRender'];
};
const previewRenderBindings = new WeakMap<THREE.Scene, PreviewRenderBinding>();

function bindPreviewRender(scene: THREE.Scene, update: () => void): () => void {
  let binding = previewRenderBindings.get(scene);
  if (!binding) {
    const previous = scene.onBeforeRender;
    const callbacks = new Set<() => void>();
    const render: THREE.Scene['onBeforeRender'] = function (...args) {
      previous.apply(scene, args);
      callbacks.forEach(callback => callback());
    };
    binding = { callbacks, previous, render };
    scene.onBeforeRender = render;
    previewRenderBindings.set(scene, binding);
  }
  binding.callbacks.add(update);
  const current = binding;
  return () => {
    current.callbacks.delete(update);
    if (current.callbacks.size > 0) return;
    if (scene.onBeforeRender === current.render) scene.onBeforeRender = current.previous;
    if (previewRenderBindings.get(scene) === current) previewRenderBindings.delete(scene);
  };
}

/** Editor overlay sampled by the existing Three render loop, without a separate frame timer. */
export class MorphVertexPreview {
  private readonly cache = new Map<string, MorphVertexPreviewSample>();
  private points: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial> | null = null;
  private active: { morphName: string; meshNames?: string[] } | null = null;
  private renderData: MorphVertexPreviewRenderData | null = null;
  private disposed = false;
  private unbindRender: (() => void) | null = null;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly options: MorphVertexPreviewOptions = {},
  ) {}

  show(morphName: string, meshNames?: string[]): void {
    if (this.disposed) return;
    if (meshNames?.length === 0) {
      this.hide();
      return;
    }
    if (this.active?.morphName !== morphName
      || this.active?.meshNames?.length !== meshNames?.length
      || meshNames?.some((name, index) => name !== this.active?.meshNames?.[index])) {
      this.cache.clear();
      this.renderData = null;
    }
    this.active = { morphName, meshNames: meshNames?.slice() };
    this.unbindRender ??= bindPreviewRender(this.scene, () => this.update());
    this.update();
  }

  hide(): void {
    this.active = null;
    this.cache.clear();
    this.renderData = null;
    this.unbindRender?.();
    this.unbindRender = null;
    if (this.points) this.points.visible = false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.hide();
    this.cache.clear();
    if (!this.points) return;
    this.points.removeFromParent();
    this.points.geometry.dispose();
    this.points.material.dispose();
    this.points = null;
  }

  private createPoints(): THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial> {
    const points = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({
      size: 0.012,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      vertexColors: true,
      toneMapped: false,
    }));
    points.name = 'MorphVertexPreviewPoints';
    points.renderOrder = 500;
    points.frustumCulled = false;
    points.visible = false;
    this.scene.add(points);
    this.points = points;
    return points;
  }

  private update(): void {
    if (this.disposed || !this.active) return;
    const { morphName, meshNames } = this.active;
    const meshes = resolveMorphPreviewMeshes(this.scene, morphName, meshNames);
    const data = buildMorphVertexPreviewRenderData(meshes, morphName, this.cache, this.options, this.renderData);
    this.renderData = data;
    if (!data) {
      if (this.points) this.points.visible = false;
      return;
    }
    const points = this.points ?? this.createPoints();
    this.updateGeometry(points.geometry, data);
    points.geometry.computeBoundingSphere();
    points.material.size = data.pointCount > 6000 ? 0.009 : 0.012;
    points.visible = true;
  }

  private updateGeometry(
    geometry: THREE.BufferGeometry,
    data: MorphVertexPreviewRenderData,
  ): void {
    const position = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    const color = geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
    if (!position || !color || position.count !== data.pointCount || color.count !== data.pointCount) {
      // Let Three release the old GPU attributes before replacing their handles.
      if (position || color) geometry.dispose();
      geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
      geometry.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
      return;
    }
    if (position.array !== data.positions) position.array.set(data.positions);
    if (color.array !== data.colors) color.array.set(data.colors);
    position.needsUpdate = true;
    color.needsUpdate = true;
  }
}
