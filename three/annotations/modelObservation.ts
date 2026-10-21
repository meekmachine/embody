import * as THREE from 'three';
import { requireInitializedEmbodyCore } from '@lovelace_lol/embody/wasm';
import type { NativeAnnotationRuntime } from './runtime';
import type { AnnotationAnchoredRegion } from './types';
import { getRuntimeAUMorphAnchorPoint } from './runtimeAnnotationSidePreview';

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

/** Stable native handle table. No region matching or anchor policy lives here. */
export class AnnotationModelObserver {
  readonly objects = new Map<number, THREE.Object3D>();
  readonly meshes: THREE.Mesh[] = [];
  private readonly ids = new Map<THREE.Object3D, number>();
  constructor(readonly model: THREE.Object3D) {
    model.traverse(object => {
      const id = this.objects.size + 1;
      this.ids.set(object, id); this.objects.set(id, object);
      if ((object as THREE.Mesh).isMesh) this.meshes.push(object as THREE.Mesh);
    });
  }
  id(object: THREE.Object3D): number | undefined { return this.ids.get(object); }
  capture(): AnnotationModelObservation {
    this.model.updateWorldMatrix(true, true);
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
    this.model.updateWorldMatrix(true, true);
    const values = new Float32Array(ids.length * 17);
    ids.forEach((id, index) => { const object = this.objects.get(id); if (object) { values[index * 17] = id; values.set(object.matrixWorld.elements, index * 17 + 1); } });
    return values;
  }
  morphAnchors(runtime: NativeAnnotationRuntime): Record<string, { x: number; y: number; z: number }> {
    const requests = JSON.parse(runtime.command('morphRequests', '{}', performance.now())) as { objectId: number; region: AnnotationAnchoredRegion }[];
    const anchors: Record<string, { x: number; y: number; z: number }> = {};
    for (const request of requests) {
      const mesh = this.objects.get(request.objectId) as THREE.Mesh | undefined;
      if (!mesh?.isMesh) continue;
      const point = getRuntimeAUMorphAnchorPoint(request.region, mesh);
      if (point) anchors[request.region.name] = { x: point.x, y: point.y, z: point.z };
    }
    return anchors;
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
