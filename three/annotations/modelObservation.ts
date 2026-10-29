import * as THREE from 'three';
import { requireInitializedEmbodyCore } from '@lovelace_lol/embody/wasm';
import type { NativeAnnotationRuntime } from './runtime';

type Bounds = { min: number[]; max: number[] };
export interface AnnotationModelObservation {
  bounds: Bounds;
  quaternion: number[];
  inverse: number[];
  objects: { id: number; name: string; kind: string; parent: number | null; position: number[]; bounds: Bounds | null; matrix: number[]; inverse: number[]; morphNames: string[] }[];
}
export function readAttribute(attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): Float32Array {
  const values = new Float32Array(attribute.count * attribute.itemSize);
  for (let index = 0; index < attribute.count; index++) for (let axis = 0; axis < attribute.itemSize; axis++) values[index * attribute.itemSize + axis] = attribute.getComponent(index, axis);
  return values;
}
const bounds = (box: THREE.Box3): Bounds | null => box.isEmpty() ? null : { min: box.min.toArray(), max: box.max.toArray() };
type MorphObservation = {
  planId: number;
  mesh: THREE.Mesh;
  geometry: THREE.BufferGeometry;
  position: THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
  indices: Uint32Array;
  samples: Float32Array;
};

/** Stable native handle table. No region matching or anchor policy lives here. */
export class AnnotationModelObserver {
  readonly objects = new Map<number, THREE.Object3D>();
  readonly meshes: THREE.Mesh[] = [];
  private readonly ids = new Map<THREE.Object3D, number>();
  private morphGeneration: number | null = null;
  private morphObservations: MorphObservation[] = [];
  private readonly vertex = new THREE.Vector3();
  constructor(readonly model: THREE.Object3D) {
    model.traverse(object => {
      const id = this.objects.size + 1;
      this.ids.set(object, id); this.objects.set(id, object);
      if ((object as THREE.Mesh).isMesh) this.meshes.push(object as THREE.Mesh);
    });
  }
  id(object: THREE.Object3D): number | undefined { return this.ids.get(object); }
  private updateWorldMatrices(): void {
    this.model.parent?.updateWorldMatrix(true, false);
    // SkinnedMesh updates its bind inverse in updateMatrixWorld. Bypassing that
    // override would apply a moved mesh's transform twice during CPU skinning.
    this.model.updateMatrixWorld(true);
  }
  capture(): AnnotationModelObservation {
    this.updateWorldMatrices();
    const modelBox = new THREE.Box3().setFromObject(this.model);
    if (modelBox.isEmpty()) modelBox.setFromCenterAndSize(this.model.getWorldPosition(new THREE.Vector3()), new THREE.Vector3());
    return {
      bounds: bounds(modelBox)!, quaternion: this.model.getWorldQuaternion(new THREE.Quaternion()).toArray(), inverse: this.model.matrixWorld.clone().invert().toArray(),
      objects: [...this.objects].map(([id, object]) => {
        const mesh = object as THREE.Mesh;
        const bone = (object as THREE.Bone).isBone;
        return { id, name: object.name, kind: mesh.isMesh ? 'Mesh' : bone ? 'Bone' : object.type, parent: object.parent ? this.ids.get(object.parent) ?? null : null,
          position: object.getWorldPosition(new THREE.Vector3()).toArray(), bounds: bone ? null : bounds(new THREE.Box3().setFromObject(object)), matrix: object.matrixWorld.toArray(), inverse: object.matrixWorld.clone().invert().toArray(), morphNames: Object.keys(mesh.morphTargetDictionary ?? {}) };
      }),
    };
  }
  observe(runtime: NativeAnnotationRuntime): void { runtime.observe_model(JSON.stringify(this.capture())); }
  transforms(runtime: NativeAnnotationRuntime): Float32Array {
    const ids = runtime.tracked_objects();
    if (!ids.length) return new Float32Array();
    this.updateWorldMatrices();
    const values = new Float32Array(ids.length * 17);
    ids.forEach((id, index) => { const object = this.objects.get(id); if (object) { values[index * 17] = id; values.set(object.matrixWorld.elements, index * 17 + 1); } });
    return values;
  }
  prepareMorphAnchors(runtime: NativeAnnotationRuntime): void {
    const generation = runtime.generation();
    if (this.morphGeneration === generation || !runtime.is_current(generation)) return;
    this.morphGeneration = generation;
    this.morphObservations = [];
    const requests = JSON.parse(runtime.command('morphRequests', '{}', performance.now())) as { objectId: number; region: { name: string }; morphNames: string[] }[];
    for (const request of requests) {
      const mesh = this.objects.get(request.objectId) as THREE.Mesh | undefined;
      if (!mesh?.isMesh) continue;
      const position = mesh.geometry.getAttribute('position');
      if (!position || position.itemSize !== 3) continue;
      const attributes = request.morphNames.flatMap(name => {
        const index = mesh.morphTargetDictionary?.[name];
        const attribute = index == null ? undefined : mesh.geometry.morphAttributes.position?.[index];
        return attribute ? [attribute] : [];
      });
      if (!attributes.length || attributes.some(attribute => attribute.count !== position.count || attribute.itemSize !== 3)) continue;
      const base = readAttribute(position);
      const morphs = new Float32Array(attributes.length * base.length);
      attributes.forEach((attribute, index) => morphs.set(readAttribute(attribute), index * base.length));
      const plan = runtime.prepare_morph_anchor(generation, request.objectId, request.region.name, base, morphs, mesh.geometry.morphTargetsRelative);
      if (plan.length < 2) continue;
      const indices = plan.slice(1);
      this.morphObservations.push({ planId: plan[0], mesh, geometry: mesh.geometry, position, indices, samples: new Float32Array(indices.length * 3) });
    }
  }
  /** Transport only: Rust owns the vertex selection, weights and live anchor. */
  observeMorphAnchors(runtime: NativeAnnotationRuntime): void {
    if (this.morphGeneration === null || !runtime.is_current(this.morphGeneration)) {
      this.morphObservations = [];
      this.morphGeneration = null;
      return;
    }
    if (!this.morphObservations.length) return;
    this.updateWorldMatrices();
    for (const { planId, mesh, geometry, position, indices, samples } of this.morphObservations) {
      // A topology replacement requires setModel/loadRegions; never sample old
      // vertex indices against a different native attribute in the meantime.
      if (mesh.geometry !== geometry || geometry.getAttribute('position') !== position) continue;
      const skinned = mesh as THREE.SkinnedMesh;
      if (skinned.isSkinnedMesh) skinned.skeleton.update();
      indices.forEach((index, offset) => {
        mesh.getVertexPosition(index, this.vertex).applyMatrix4(mesh.matrixWorld);
        samples[offset * 3] = this.vertex.x;
        samples[offset * 3 + 1] = this.vertex.y;
        samples[offset * 3 + 2] = this.vertex.z;
      });
      runtime.observe_morph_anchor(this.morphGeneration, planId, samples);
    }
  }
  /** Rust selects influenced vertices; Three evaluates the current native pose. */
  observeFocus(runtime: NativeAnnotationRuntime, request: unknown): void {
    const observation = this.capture();
    runtime.observe_model(JSON.stringify(observation));
    const ids = JSON.parse(runtime.command('focusObjects', JSON.stringify(request), performance.now())) as number[];
    const core = requireInitializedEmbodyCore();
    for (const id of ids) {
      const object = this.objects.get(id);
      if (!(object as THREE.Bone | undefined)?.isBone) continue;
      const points: number[] = [];
      for (const nativeMesh of this.meshes) {
        const mesh = nativeMesh as THREE.SkinnedMesh;
        if (!mesh.isSkinnedMesh) continue;
        const index = mesh.skeleton.bones.indexOf(object as THREE.Bone);
        const skinIndices = mesh.geometry.getAttribute('skinIndex');
        const skinWeights = mesh.geometry.getAttribute('skinWeight');
        if (index < 0 || !skinIndices || !skinWeights) continue;
        mesh.skeleton.update();
        const selected = core.annotation_bone_vertices(readAttribute(skinIndices), readAttribute(skinWeights), new Uint32Array([index]));
        const vertex = new THREE.Vector3();
        for (const selectedIndex of selected) { mesh.getVertexPosition(selectedIndex, vertex).applyMatrix4(mesh.matrixWorld); points.push(vertex.x, vertex.y, vertex.z); }
      }
      const measured = core.annotation_point_bounds(new Float32Array(points));
      const entry = observation.objects.find(entry => entry.id === id);
      if (entry && measured.length === 6) entry.bounds = { min: Array.from(measured.slice(0, 3)), max: Array.from(measured.slice(3, 6)) };
    }
    runtime.observe_model(JSON.stringify(observation));
  }
}

export function observeAnnotationModel(model: THREE.Object3D): AnnotationModelObservation { return new AnnotationModelObserver(model).capture(); }
