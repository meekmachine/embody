import { Matrix4, Quaternion, Vector3 } from 'three';
import type { Object3D } from 'three';
import { requireInitializedEmbodyCore } from '../wasm/index';
import type { RuntimeCore } from '../wasm/index';
import { ThreeModelInspector } from './index';
import type { ThreeModelInspection } from './index';
import { bindModelReferencePose, captureModelReferencePose } from './reference-pose';
import type { ThreeModelReferencePose, ThreeReferencePoseNode } from './reference-pose';

type Vec3 = [number, number, number];
type Quat = [number, number, number, number];

/** One unsigned canonical AU value. Opposite directional AUs may coexist. */
export type AuContributionSample = { id: number; intensity: number; balance?: number };
export type AuRotationResponse = {
  auId: number;
  side: 'left' | 'right' | 'center';
  axis: Vec3;
  /** Signed radians at AU intensity one; axes are bone-local. */
  radians: number;
  /** Compiled composite-axis order; may differ from semantic yaw/pitch/roll. */
  order: number;
};
export type GazeJointGeometry = {
  boneId: number;
  nodeId: number;
  name: string;
  opticalAxis: Vec3 | null;
  /** Negative/positive name FACS control coordinates, not physical rotation signs. */
  axes: Record<'yaw' | 'pitch' | 'roll', {
    negative: AuRotationResponse | null;
    positive: AuRotationResponse | null;
  }>;
};
export type AuPoseNode = {
  id: number;
  name: string;
  parentId: number | null;
  matrixAutoUpdate: boolean;
  /** All matrices use Three's column-major convention. */
  parentWorldMatrix: number[];
  position: Vec3;
  quaternion: Quat;
  scale: Vec3;
  localMatrix: number[];
  worldMatrix: number[];
  referencePosition: Vec3;
  referenceQuaternion: Quat;
  referenceScale: Vec3;
  referenceLocalMatrix: number[];
};
export type AuPoseGeometry = {
  bindingRevision: number;
  modelNodeId: number;
  nodes: AuPoseNode[];
  joints: Record<'head' | 'leftEye' | 'rightEye', GazeJointGeometry | null>;
};
export type EvaluatedAuContribution = {
  bindingRevision: number;
  bones: Array<{ boneId: number; nodeId: number; rotationDelta?: Quat; positionDelta?: Vec3 }>;
  morphs: Array<{ meshId: number; morphTargetId: number; value: number }>;
};
export type ThreeAuContributionOptions = { referencePose?: ThreeModelReferencePose };

type Binding = {
  model: Object3D;
  core: RuntimeCore;
  inspection: ThreeModelInspection;
  references: ReadonlyMap<Object3D, ThreeReferencePoseNode>;
  referencePose: ThreeModelReferencePose;
  nodeIds: Map<Object3D, number>;
  joints: AuPoseGeometry['joints'];
  revision: number;
};
type SavedBone = {
  position?: { base: Vector3; applied: Vector3 };
  rotation?: { base: Quaternion; applied: Quaternion };
};
type SavedMorph = { influences: number[]; index: number; base: number; applied: number };
let nextBindingRevision = 1;
const vector = (value: { x: number; y: number; z: number }): Vec3 => [value.x, value.y, value.z];
const rotation = (value: { x: number; y: number; z: number; w: number }): Quat => [value.x, value.y, value.z, value.w];
const finite = (values: readonly number[], description: string) => {
  if (!values.every(Number.isFinite)) throw new Error(`Invalid AU contribution ${description}: nonfinite values`);
};
const sameOrientation = (a: Quaternion, b: Quaternion) => {
  const norm = Math.sqrt(a.lengthSq() * b.lengthSq());
  return norm > 0 && Number.isFinite(norm) && Math.abs(a.dot(b)) / norm > 1 - 1e-12;
};

function bind(model: Object3D, profile: unknown, options: ThreeAuContributionOptions): Binding {
  const referencePose = options.referencePose ?? captureModelReferencePose(model);
  const references = bindModelReferencePose(model, referencePose);
  const inspection = new ThreeModelInspector().inspectModel(model, { profile, referencePose });
  const core = new (requireInitializedEmbodyCore().RuntimeCore)(0);
  try {
    core.configure_with_profile(JSON.stringify(profile), JSON.stringify(inspection.descriptor));
    const nodeIds = new Map(Array.from(inspection.objectBindings, ([id, object]) => [object, id]));
    const joints = JSON.parse(core.get_gaze_kinematics_json()) as AuPoseGeometry['joints'];
    for (const key of ['head', 'leftEye', 'rightEye'] as const) {
      const joint = joints[key];
      const object = joint && inspection.boneBindings.get(joint.boneId);
      if (joint && object) joint.nodeId = nodeIds.get(object)!;
      else joints[key] = null;
    }
    return { model, core, inspection, references, referencePose, nodeIds, joints, revision: nextBindingRevision++ };
  } catch (error) {
    core.free();
    throw error;
  }
}

/**
 * Generic sampled AU contribution, with no target, behavior settings or clock.
 * An isolated canonical RuntimeCore evaluates unsigned AU samples for all mapped
 * bones and morphs. The host restores this contribution before its mixer pass,
 * reads the evaluated base if needed, then applies the next scheduled sample.
 */
export class ThreeAuContribution {
  private binding: Binding;
  private activeIds = new Set<number>();
  private savedBones = new Map<Object3D, SavedBone>();
  private savedMorphs: SavedMorph[] = [];
  private disposed = false;

  constructor(model: Object3D, profile: unknown, options: ThreeAuContributionOptions = {}) {
    this.binding = bind(model, profile, options);
  }

  private requireBinding() {
    if (this.disposed) throw new Error('AU contribution is disposed');
    return this.binding;
  }

  /** Current pose facts. Refreshes Three matrix caches; never changes TRS/morphs. */
  readPose(): AuPoseGeometry {
    const { model, inspection, nodeIds, references, joints, revision } = this.requireBinding();
    model.updateWorldMatrix(true, true);
    const nodes: AuPoseNode[] = [];
    let count = 0;
    model.traverse((object) => {
      count += 1;
      const id = nodeIds.get(object);
      const reference = references.get(object);
      if (id === undefined || !reference || object.name !== reference.name || object.children.length !== reference.childCount ||
          (object !== model && references.get(object.parent!)?.path !== reference.parentPath)) {
        throw new Error('AU contribution hierarchy changed; rebind with an explicit reference pose');
      }
      const row: AuPoseNode = {
        id, name: object.name, parentId: object === model ? null : nodeIds.get(object.parent!) ?? null,
        matrixAutoUpdate: object.matrixAutoUpdate,
        parentWorldMatrix: object.parent?.matrixWorld.toArray() ?? new Matrix4().toArray(),
        position: vector(object.position), quaternion: rotation(object.quaternion), scale: vector(object.scale),
        localMatrix: object.matrix.toArray(), worldMatrix: object.matrixWorld.toArray(),
        referencePosition: vector(reference.transform.position),
        referenceQuaternion: rotation(reference.transform.rotation),
        referenceScale: vector(reference.transform.scale), referenceLocalMatrix: [...reference.localMatrix],
      };
      finite([...row.position, ...row.quaternion, ...row.scale, ...row.localMatrix, ...row.worldMatrix, ...row.parentWorldMatrix], 'pose');
      nodes.push(row);
    });
    if (count !== inspection.objectBindings.size) throw new Error('AU contribution hierarchy changed; rebind');
    // No renderer handles or shared mutable metadata cross the observation API.
    return { bindingRevision: revision, modelNodeId: nodeIds.get(model)!, nodes,
      joints: JSON.parse(JSON.stringify(joints)) as AuPoseGeometry['joints'] };
  }

  /** Canonical AU effects relative to reference; does not change the scene. */
  evaluate(samples: readonly AuContributionSample[]): EvaluatedAuContribution {
    const { core, inspection, nodeIds, references, revision } = this.requireBinding();
    if (!Array.isArray(samples)) throw new Error('AU contribution samples must be an array');
    const ids = new Set<number>();
    // Validate the COMPLETE replacement before updating even isolated state.
    const rows = Array.from(samples, (sample) => {
      if (!sample || !Number.isInteger(sample.id) || sample.id < 0 || sample.id > 0xffffffff || ids.has(sample.id)) {
        throw new Error('AU contribution requires unique unsigned AU ids');
      }
      const balance = sample.balance ?? 0;
      finite([sample.intensity, balance], 'sample');
      if (sample.intensity < 0 || sample.intensity > 1 || balance < -1 || balance > 1) {
        throw new Error('AU contribution intensity must be in [0,1] and balance in [-1,1]');
      }
      ids.add(sample.id);
      return { id: sample.id, intensity: sample.intensity, balance };
    });
    for (const id of this.activeIds) if (!ids.has(id)) core.set_au(id, 0, 0);
    for (const sample of rows) core.set_au(sample.id, sample.intensity, sample.balance);
    this.activeIds = ids;
    const result: EvaluatedAuContribution = { bindingRevision: revision, bones: [], morphs: [] };
    const bones = core.evaluate_active_bone_frame();
    finite(Array.from(bones), 'evaluated bone frame');
    for (let offset = 0; offset + 9 <= bones.length; offset += 9) {
      const boneId = bones[offset];
      const object = inspection.boneBindings.get(boneId);
      if (!object) continue;
      const reference = references.get(object)!;
      const row: EvaluatedAuContribution['bones'][number] = { boneId, nodeId: nodeIds.get(object)! };
      if (bones[offset + 8] & 1) row.positionDelta = [
        bones[offset + 1] - reference.transform.position.x,
        bones[offset + 2] - reference.transform.position.y,
        bones[offset + 3] - reference.transform.position.z,
      ];
      if (bones[offset + 8] & 2) {
        const base = reference.transform.rotation;
        row.rotationDelta = rotation(new Quaternion(base.x, base.y, base.z, base.w).invert()
          .multiply(new Quaternion(bones[offset + 4], bones[offset + 5], bones[offset + 6], bones[offset + 7])).normalize());
      }
      result.bones.push(row);
    }
    const morphs = core.evaluate_active_morph_frame();
    finite(Array.from(morphs), 'evaluated morph frame');
    for (let offset = 0; offset + 4 <= morphs.length; offset += 4) {
      result.morphs.push({ meshId: morphs[offset], morphTargetId: morphs[offset + 1], value: morphs[offset + 2] });
    }
    return result;
  }

  /** Replace the prior contribution while preserving authored/external writes. */
  apply(samples: readonly AuContributionSample[]): EvaluatedAuContribution {
    const result = this.evaluate(samples);
    const { model, inspection } = this.requireBinding();
    // Preflight before restoring the previous contribution; unsupported manual
    // matrices must not leave a partially applied semantic frame.
    for (const row of result.bones) {
      const object = inspection.boneBindings.get(row.boneId)!;
      if (!object.matrixAutoUpdate) throw new Error(`AU contribution cannot write manual-matrix bone ${object.name}`);
      finite([...vector(object.position), ...rotation(object.quaternion)], 'base pose');
    }
    for (const row of result.morphs) {
      const binding = inspection.morphBindings.get(row.morphTargetId);
      if (binding?.mesh.morphTargetInfluences) finite([binding.mesh.morphTargetInfluences[binding.index]], 'base morph');
    }
    this.restore();
    for (const row of result.bones) {
      const object = inspection.boneBindings.get(row.boneId)!;
      const saved: SavedBone = {};
      if (row.positionDelta) {
        const base = object.position.clone();
        object.position.add(new Vector3(...row.positionDelta));
        saved.position = { base, applied: object.position.clone() };
      }
      if (row.rotationDelta) {
        const base = object.quaternion.clone();
        object.quaternion.multiply(new Quaternion(...row.rotationDelta));
        saved.rotation = { base, applied: object.quaternion.clone() };
      }
      this.savedBones.set(object, saved);
    }
    for (const row of result.morphs) {
      const binding = inspection.morphBindings.get(row.morphTargetId);
      const influences = binding?.mesh.morphTargetInfluences;
      if (!binding || !influences) continue;
      const base = influences[binding.index];
      const applied = Math.max(0, Math.min(1, base + row.value));
      influences[binding.index] = applied;
      this.savedMorphs.push({ influences, index: binding.index, base, applied });
    }
    model.updateWorldMatrix(true, true);
    return result;
  }

  restore() {
    if (this.disposed) return;
    for (const [object, saved] of this.savedBones) {
      if (saved.position && object.position.equals(saved.position.applied)) object.position.copy(saved.position.base);
      if (saved.rotation && sameOrientation(object.quaternion, saved.rotation.applied)) object.quaternion.copy(saved.rotation.base);
    }
    for (const saved of this.savedMorphs) {
      if (saved.influences[saved.index] === saved.applied) saved.influences[saved.index] = saved.base;
    }
    this.savedBones.clear();
    this.savedMorphs = [];
    this.binding.model.updateWorldMatrix(true, true);
  }

  rebind(model: Object3D, profile: unknown, options: ThreeAuContributionOptions = {}) {
    const previous = this.requireBinding();
    // Binding errors retain the old runtime and visible contribution intact.
    // Rebinding the same model must not capture our current contribution or an
    // animated pose as a new neutral reference.
    const referencePose = options.referencePose ?? (model === previous.model ? previous.referencePose : undefined);
    const next = bind(model, profile, { referencePose });
    this.restore();
    this.binding.core.free();
    this.binding = next;
    this.activeIds.clear();
  }

  dispose() {
    if (this.disposed) return;
    this.restore();
    this.binding.core.free();
    this.disposed = true;
  }
}
