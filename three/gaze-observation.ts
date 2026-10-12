import { Matrix4, Quaternion, Vector3 } from 'three';
import type { Object3D } from 'three';
import { requireInitializedEmbodyCore } from '../wasm/index';
import { bindModelReferencePose } from './reference-pose';
import type { ThreeModelReferencePose, ThreeReferencePoseNode } from './reference-pose';

type GazeVector = [number, number, number];
type GazeQuaternion = [number, number, number, number];
export type ThreeGazeRotationResponse = {
  auId: number;
  side: 'left' | 'right' | 'center';
  axis: GazeVector;
  radians: number;
  order: number;
};
export type ThreeGazeAxes = Record<'yaw' | 'pitch' | 'roll', {
  negative: ThreeGazeRotationResponse | null;
  positive: ThreeGazeRotationResponse | null;
}>;
type GazeReferenceJoint = {
  name: string;
  referencePosition: GazeVector;
  referenceQuaternion: GazeQuaternion;
  referenceScale: GazeVector;
  axes: ThreeGazeAxes;
};
export type ThreeGazeRigHead = GazeReferenceJoint & { parentInModelMatrix: number[] };
export type ThreeGazeRigEye = GazeReferenceJoint & {
  side: 'left' | 'right';
  parentInHeadMatrix: number[];
  originInModel: GazeVector;
  opticalAxis: GazeVector;
};
export type ThreeGazeRigReason = 'missing-reference-pose' | 'invalid-reference-pose'
  | 'invalid-profile' | 'missing-head-bone' | 'missing-eye-bone' | 'missing-eye-mapping'
  | 'unknown-optical-axis' | 'duplicate-eye-bone' | 'eye-outside-head-hierarchy'
  | 'unsupported-joint-transform' | 'unsupported-chain-mapping' | 'invalid-model-transform';
export type ThreeGazeRigGeometry = {
  version: 1;
  status: 'available' | 'unavailable';
  reason: ThreeGazeRigReason | null;
  modelWorldMatrix: number[] | null;
  head: ThreeGazeRigHead | null;
  eyes: ThreeGazeRigEye[];
};
export type ThreeGazeObserverOptions = { referencePose?: ThreeModelReferencePose };
type ResolvedJoint = { boneId: number; name: string; opticalAxis: GazeVector | null;
  unsupportedAuIds: number[]; axes: ThreeGazeAxes };
type ResolvedRig = { head: ResolvedJoint | null; leftEye: ResolvedJoint | null; rightEye: ResolvedJoint | null;
  drivenBones: Array<{ boneId: number; auId: number; kind: 'rotation' | 'translation' }> };

// Positions use the caller's world-space scene units; directions are normalized
// world vectors. Angles are degrees, never normalized AU intensities. Keeping
// the result as detached plain data lets an agency reason about a measured fact
// without receiving a Three object or a way to mutate the renderer.
export type ThreeGazePoint = { x: number; y: number; z: number };
export type ThreeGazeObservedEye = {
  side: 'left' | 'right';
  name: string;
  origin: ThreeGazePoint;
  direction: ThreeGazePoint;
  angularErrorDeg: number;
};
// Unavailable is distinct from a large error. A large finite error is a valid
// observation of a miss; missing geometry/calibration is not evidence of either
// success or failure to rotate toward the target.
export type ThreeGazeObservationReason = 'invalid-target' | 'missing-eye-bone'
  | 'missing-eye-mapping' | 'unknown-optical-axis' | 'invalid-eye-transform' | 'coincident-target'
  | 'duplicate-eye-bone';
export type ThreeGazeObservation = {
  status: 'available' | 'unavailable';
  reason: ThreeGazeObservationReason | null;
  /** Maximum of both measured eye errors; null when either eye is unavailable. */
  angularErrorDeg: number | null;
  /** Valid individual measurements remain available when the other eye is missing. */
  eyes: ThreeGazeObservedEye[];
};

// The profile arrives as unknown at this adapter boundary. These narrow reads
// tolerate absent optional fields while rejecting malformed required geometry;
// they do not coerce strings into coordinates or manufacture a mapped eye.
type Data = Record<string, unknown>;
type Eye = { side: 'left' | 'right'; name: string; optical?: Vector3; reason?: ThreeGazeObservationReason };
const EPSILON = 1e-8;
const data = (value: unknown): Data => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Data : {};
const number = (value: unknown, fallback = 0) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const point = (value: Vector3): ThreeGazePoint => ({ x: value.x, y: value.y, z: value.z });
const finitePoint = (value: unknown): value is ThreeGazePoint => {
  const input = data(value);
  return ['x', 'y', 'z'].every(key => typeof input[key] === 'number' && Number.isFinite(input[key]));
};
const selector = (value: unknown): unknown[] => Array.isArray(value) ? value : typeof value === 'number' ? [value] : [];

/**
 * Observe rendered binocular rays once after the host has applied its mixer.
 * This owns no playback, target selection, pose solver, clock or pose writes.
 * Construct a new observer after replacing the model or profile. Matrix caches
 * are refreshed for the read; local transforms and morph values are untouched.
 *
 * The host decides when a measurement is useful, normally after native clip
 * completion has applied bindings. This class does not subscribe to frames,
 * declare a goal settled, apply a tolerance, or compensate an authored nod.
 * It can therefore report the residual from shared parallel eye channels at a
 * finite-distance target honestly, rather than equating playback with focus.
 */
export class ThreeGazeObserver {
  private eyes: Eye[];
  private readonly profileJson: string;
  private readonly referencePose?: ThreeModelReferencePose;
  private rigGeometry?: ThreeGazeRigGeometry;

  constructor(private readonly model: Object3D, profile: unknown, options: ThreeGazeObserverOptions = {}) {
    this.profileJson = JSON.stringify(profile ?? {});
    this.referencePose = options.referencePose;
    const source = data(profile);
    const names = data(source.boneNodes);
    const characterization = data(source.humanoidCharacterization);
    const roles = data(characterization.roles);
    // Resolve semantic EYE_L/EYE_R through saved naming/characterization, just
    // as other adapter bindings do. Prefix/suffix handling avoids doubling
    // an already-qualified bone name. Do not discover eyes heuristically: a
    // missing configured object must remain a visible unavailable result.
    const name = (node: string): string => {
      const role = data(roles[node] ?? Object.values(roles).find(value => data(value).nodeKey === node));
      const mappedKey = characterization.schemaVersion === 1 && characterization.standard === 'VRMC_vrm-1.0'
        && typeof role.nodeKey === 'string' ? role.nodeKey : node;
      const base = typeof names[mappedKey] === 'string' ? names[mappedKey] as string : mappedKey;
      if (typeof role.exactBoneName === 'string' && base === role.exactBoneName) return base;
      const prefix = typeof source.bonePrefix === 'string' ? source.bonePrefix : '';
      const suffix = typeof source.boneSuffix === 'string' ? source.boneSuffix : '';
      return `${base.startsWith(prefix) ? '' : prefix}${base}${base.endsWith(suffix) ? '' : suffix}`;
    };
    const active = (node: string, id: number): boolean => {
      // Missing/null composite tables retain the legacy eye mappings. An
      // explicitly empty table disables them, just as in the Rust compiler.
      // This is calibration eligibility, not an AU evaluator: Rust still owns
      // compiling/applying movement. We only need to know that a saved signed
      // rotational response is unambiguous enough to define an optical basis.
      if (source.compositeRotations == null) return true;
      if (!Array.isArray(source.compositeRotations)) return false;
      let responses = 0;
      for (const entry of source.compositeRotations) {
        const composite = data(entry);
        if (typeof composite.node !== 'string' || name(composite.node) !== name(node)) continue;
        for (const key of ['yaw', 'pitch', 'roll']) {
          const axis = data(composite[key]);
          const negative = selector(axis.negative);
          const positive = selector(axis.positive);
          // The Rust composite compiler uses directional subtraction only
          // when BOTH selector sides exist. An ID on both sides cancels; with
          // an incomplete pair the plain `aus` list determines participation.
          const driven = negative.length && positive.length
            ? negative.includes(id) !== positive.includes(id) : selector(axis.aus).includes(id);
          if (driven) responses += 1;
        }
      }
      // More than one response cannot be summarized as one calibration axis.
      // Refusing that inference is preferable to inventing an optical ray.
      return responses === 1;
    };
    const binding = (node: string, id: number): Vector3 | undefined => {
      const rows = data(source.auToBones)[id];
      // Match the compiler's first binding for this resolved bone. Searching
      // past a cleared/nonrotation first row could invent a response that the
      // actual compiled AU does not have.
      const row = data(Array.isArray(rows) ? rows.find(value => {
        const candidate = data(value);
        return typeof candidate.node === 'string' && name(candidate.node) === name(node);
      }) : undefined);
      if (!active(node, id)) return undefined;
      // Only the sign of a nonzero authored response is needed for optical
      // calibration. Its magnitude is a capacity fact supplied by Rust, not a
      // clamp or strength that this observer should apply to the rendered pose.
      const signedDegrees = number(row.maxDegrees) * number(row.scale, 1);
      if (!Number.isFinite(signedDegrees) || Math.abs(signedDegrees) < EPSILON) return undefined;
      const axis = row.channel === 'rx' ? new Vector3(1, 0, 0)
        : row.channel === 'ry' ? new Vector3(0, 1, 0) : row.channel === 'rz' ? new Vector3(0, 0, 1) : undefined;
      return axis?.multiplyScalar(Math.sign(signedDegrees));
    };
    // Cache profile-derived calibration, not scene transforms. Each observe()
    // reads the current object matrices, so authored clips remain observable;
    // replacing the profile requires a fresh observer to rebuild these facts.
    this.eyes = (['left', 'right'] as const).map((side): Eye => {
      const node = side === 'left' ? 'EYE_L' : 'EYE_R';
      const eye: Eye = { side, name: name(node) };
      const positiveYaw = binding(node, 61);
      const negativeYaw = binding(node, 62);
      const positivePitch = binding(node, 63);
      const negativePitch = binding(node, 64);
      // Explicit optical calibration does not resurrect deliberately cleared
      // tracking mappings. At least one usable eye rotation is still required.
      if (!positiveYaw && !negativeYaw && !positivePitch && !negativePitch) {
        return { ...eye, reason: 'missing-eye-mapping' };
      }
      // An authored optical axis is bone-local and takes precedence when its
      // length is usable; the result is normalized below. Sparse coordinates
      // default to zero, but a present nonnumeric/nonfinite value is malformed.
      const calibration = data(data(source.gazeCalibration)[`${side}Eye`]).opticalAxis;
      const explicit = data(calibration);
      if (calibration != null && (typeof calibration !== 'object' || Array.isArray(calibration)
        || ['x', 'y', 'z'].some(key => explicit[key] != null
          && (typeof explicit[key] !== 'number' || !Number.isFinite(explicit[key]))))) {
        return { ...eye, reason: 'unknown-optical-axis' };
      }
      const optical = new Vector3(number(explicit.x), number(explicit.y), number(explicit.z));
      if (optical.lengthSq() < EPSILON) {
        // Same signed yaw × pitch calibration as ThreeGazeFocus.joint:
        // CC4 rz/negative-rx yields -Y; ry/negative-rx yields +Z. A missing
        // positive direction can use the opposite authored direction with its
        // sign reversed. Parallel or missing axes cannot define a forward ray.
        const yaw = positiveYaw ?? negativeYaw?.negate();
        const pitch = positivePitch ?? negativePitch?.negate();
        if (yaw && pitch) optical.crossVectors(yaw, pitch);
      }
      return Number.isFinite(optical.lengthSq()) && optical.lengthSq() >= EPSILON
        ? { ...eye, optical: optical.normalize() } : { ...eye, reason: 'unknown-optical-axis' };
    });
  }

  private referenceGeometry(): ThreeGazeRigGeometry {
    const unavailable = (reason: ThreeGazeRigReason): ThreeGazeRigGeometry =>
      ({ version: 1, status: 'unavailable', reason, modelWorldMatrix: null, head: null, eyes: [] });
    if (!this.referencePose) return unavailable('missing-reference-pose');
    let references: ReadonlyMap<Object3D, ThreeReferencePoseNode>;
    try { references = bindModelReferencePose(this.model, this.referencePose); }
    catch { return unavailable('invalid-reference-pose'); }
    const bones = [...references].filter(([, reference]) => reference.isBone);
    let resolved: ResolvedRig;
    try {
      const descriptor = { bones: bones.map(([object, reference], index) => ({
        id: index + 1, name: reference.name,
        parentName: references.get(object.parent!)?.name ?? null,
        restTransform: reference.transform,
      })) };
      resolved = JSON.parse(requireInitializedEmbodyCore().resolve_profile_gaze_rig_json(
        this.profileJson, JSON.stringify(descriptor))) as ResolvedRig;
    } catch { return unavailable('invalid-profile'); }
    this.eyes = this.eyes.map((eye): Eye => {
      const joint = eye.side === 'left' ? resolved.leftEye : resolved.rightEye;
      if (!joint) return { ...eye, reason: 'missing-eye-bone' };
      if (!Object.values(joint.axes).some(axis => axis.negative || axis.positive)) {
        return { side: eye.side, name: joint.name, reason: 'missing-eye-mapping' };
      }
      return joint.opticalAxis
        ? { side: eye.side, name: joint.name, optical: new Vector3(...joint.opticalAxis) }
        : { side: eye.side, name: joint.name, reason: 'unknown-optical-axis' };
    });
    if (!resolved.head) return unavailable('missing-head-bone');
    const headObject = bones[resolved.head.boneId - 1]?.[0];
    if (!headObject || headObject === this.model) return unavailable('missing-head-bone');
    const matrixBetween = (ancestor: Object3D, descendant: Object3D | null): Matrix4 | undefined => {
      const chain: Object3D[] = [];
      let current = descendant;
      for (; current && current !== ancestor; current = current.parent) chain.push(current);
      if (current !== ancestor) return undefined;
      const result = new Matrix4();
      for (const object of chain.reverse()) {
        const reference = references.get(object);
        if (!reference || reference.localMatrix.length !== 16 || !reference.localMatrix.every(Number.isFinite)) return undefined;
        result.multiply(new Matrix4().fromArray(reference.localMatrix));
      }
      const determinant = result.determinant();
      return result.elements.every(Number.isFinite) && Number.isFinite(determinant) && determinant !== 0 ? result : undefined;
    };
    const referenceJoint = (joint: ResolvedJoint, object: Object3D): GazeReferenceJoint | undefined => {
      if (!object.matrixAutoUpdate) return undefined;
      const reference = references.get(object)!;
      const { position, rotation, scale } = reference.transform;
      const composed = new Matrix4().compose(new Vector3(position.x, position.y, position.z),
        new Quaternion(rotation.x, rotation.y, rotation.z, rotation.w), new Vector3(scale.x, scale.y, scale.z));
      // Native quaternion clips cannot reconstruct shear in a driven joint's local matrix.
      if (!composed.elements.every((value, index) => Number.isFinite(value)
        && Math.abs(value - reference.localMatrix[index]) < 1e-6)
        || !Number.isFinite(composed.determinant()) || composed.determinant() === 0) return undefined;
      return { name: joint.name, referencePosition: [position.x, position.y, position.z],
        referenceQuaternion: [rotation.x, rotation.y, rotation.z, rotation.w],
        referenceScale: [scale.x, scale.y, scale.z], axes: joint.axes };
    };
    const head = referenceJoint(resolved.head, headObject);
    const headParent = matrixBetween(this.model, headObject.parent);
    if (!head || !headParent) return unavailable('unsupported-joint-transform');
    const result: ThreeGazeRigGeometry = { version: 1, status: 'available', reason: null, modelWorldMatrix: null,
      head: { ...head, parentInModelMatrix: headParent.toArray() }, eyes: [] };
    const fail = (reason: ThreeGazeRigReason) => { result.status = 'unavailable'; result.reason ??= reason; };
    if (resolved.head.unsupportedAuIds.length) fail('unsupported-chain-mapping');
    const seen = new Set<Object3D>();
    for (const side of ['left', 'right'] as const) {
      const joint = side === 'left' ? resolved.leftEye : resolved.rightEye;
      const object = joint && bones[joint.boneId - 1]?.[0];
      if (!joint || !object) { fail('missing-eye-bone'); continue; }
      if (seen.has(object)) { fail('duplicate-eye-bone'); continue; }
      seen.add(object);
      if (!Object.values(joint.axes).some(axis => axis.negative || axis.positive)) {
        fail('missing-eye-mapping'); continue;
      }
      if (!joint.opticalAxis) { fail('unknown-optical-axis'); continue; }
      if (joint.unsupportedAuIds.length) fail('unsupported-chain-mapping');
      if (Object.values(joint.axes).some(axis => [axis.negative, axis.positive]
        .some(response => response && response.side !== side))) fail('unsupported-chain-mapping');
      const eye = referenceJoint(joint, object);
      const parent = matrixBetween(headObject, object.parent);
      const modelMatrix = matrixBetween(this.model, object);
      if (!parent) { fail('eye-outside-head-hierarchy'); continue; }
      if (!eye || !modelMatrix) { fail('unsupported-joint-transform'); continue; }
      result.eyes.push({ ...eye, side, parentInHeadMatrix: parent.toArray(),
        originInModel: new Vector3().setFromMatrixPosition(modelMatrix).toArray(), opticalAxis: joint.opticalAxis });
    }
    for (const driven of resolved.drivenBones) {
      const object = bones[driven.boneId - 1]?.[0];
      if (!object) continue;
      const affectsEye = [...seen].some(eye => {
        for (let ancestor: Object3D | null = eye; ancestor && ancestor !== this.model; ancestor = ancestor.parent) {
          if (ancestor === object) return true;
        }
        return false;
      });
      if (affectsEye && (driven.kind === 'translation'
        || (object === headObject ? driven.auId >= 60 : !seen.has(object) || driven.auId < 60))) {
        fail('unsupported-chain-mapping');
      }
    }
    return result;
  }

  /** Static reference geometry plus current model placement; no animated joint reads. */
  getRigGeometry(): ThreeGazeRigGeometry {
    this.rigGeometry ??= this.referenceGeometry();
    const result = JSON.parse(JSON.stringify(this.rigGeometry)) as ThreeGazeRigGeometry;
    this.model.updateWorldMatrix(true, false);
    const matrix = this.model.matrixWorld;
    if (!matrix.elements.every(Number.isFinite) || !Number.isFinite(matrix.determinant()) || matrix.determinant() === 0) {
      result.status = 'unavailable'; result.reason = 'invalid-model-transform';
    } else result.modelWorldMatrix = matrix.toArray();
    return result;
  }

  observe(worldTarget: ThreeGazePoint): ThreeGazeObservation {
    if (this.referencePose) this.rigGeometry ??= this.referenceGeometry();
    // This target is supplied by the caller solely for error measurement. The
    // observer never chooses it, clamps it to AU reach, or changes it to make
    // the measured result appear successful.
    if (!finitePoint(worldTarget)) {
      return { status: 'unavailable', reason: 'invalid-target', angularErrorDeg: null, eyes: [] };
    }
    // Refresh parent/child world-matrix caches, including manual matrices.
    // This may update Three's caches but does not write local position,
    // quaternion, scale, or morph influences. Full matrices preserve parent
    // transforms and nonuniform scale that quaternion-only reads would omit.
    this.model.updateWorldMatrix(true, true);
    const target = new Vector3(worldTarget.x, worldTarget.y, worldTarget.z);
    const eyes: ThreeGazeObservedEye[] = [];
    const observed = new Set<Object3D>();
    let reason: ThreeGazeObservationReason | null = null;
    for (const eye of this.eyes) {
      const object = this.model.getObjectByName(eye.name);
      if (!object || eye.reason || !eye.optical) {
        reason ??= !object ? 'missing-eye-bone' : eye.reason ?? 'unknown-optical-axis';
        continue;
      }
      // Two role names resolving to the same object are not two measured eyes.
      // Preserve the first valid measurement, but refuse binocular success.
      if (observed.has(object)) {
        reason ??= 'duplicate-eye-bone';
        continue;
      }
      observed.add(object);
      const origin = new Vector3().setFromMatrixPosition(object.matrixWorld);
      const direction = eye.optical.clone().transformDirection(object.matrixWorld);
      if (!object.matrixWorld.elements.every(Number.isFinite) || !finitePoint(origin)
        || !finitePoint(direction) || direction.lengthSq() < EPSILON) {
        reason ??= 'invalid-eye-transform';
        continue;
      }
      // Each eye has its own origin; measuring both against the same finite
      // target exposes convergence error even when their directions match.
      // A coincident target has no defined direction and must remain absent.
      const desired = target.clone().sub(origin);
      if (!Number.isFinite(desired.lengthSq()) || desired.lengthSq() < EPSILON) {
        reason ??= desired.lengthSq() < EPSILON ? 'coincident-target' : 'invalid-target';
        continue;
      }
      const angularErrorDeg = direction.angleTo(desired) * 180 / Math.PI;
      eyes.push({ side: eye.side, name: object.name, origin: point(origin), direction: point(direction), angularErrorDeg });
    }
    // The worst eye error is the aggregate only when both eyes are usable.
    // Keep partial measurements for diagnostics, but use null (not zero) for
    // the aggregate when either eye is missing or otherwise unavailable.
    return { status: reason ? 'unavailable' : 'available', reason,
      angularErrorDeg: reason ? null : Math.max(...eyes.map(eye => eye.angularErrorDeg)), eyes };
  }
}
