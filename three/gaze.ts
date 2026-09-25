import { Matrix4, Quaternion, Vector3 } from 'three';
import type { Object3D } from 'three';
import { bindModelReferencePose, captureModelReferencePose } from './reference-pose';
import type { ThreeModelReferencePose, ThreeReferencePoseNode } from './reference-pose';

type Point = { x: number; y: number; z: number };
type Rotation = Point & { w: number };
type Target = { x: number; y: number; z?: number };
type Flags = { eyesEnabled?: boolean; headEnabled?: boolean };
type AxisBinding = { axis: Vector3; radians: number };
type Axis = { negative?: AxisBinding; positive?: AxisBinding };
type Limits = { negative: number; positive: number };
type Joint = {
  object: Object3D; optical: Vector3; yaw: Axis; pitch: Axis; roll: Axis;
  reference: Quaternion; referenceParent: Matrix4; referenceScale: Vector3;
};

export type ThreeGazeFocusOptions = {
  /** Reuse the import reference when constructing the constraint during playback. */
  referencePose?: ThreeModelReferencePose;
};

export type ThreeGazeFocusRequest = Flags & {
  worldTarget: Point;
  /** Aggregate FACS bearing normalized against full head + eye capacities. */
  target: Target;
  headTarget?: Target;
  eyeIntensity?: number;
  headIntensity?: number;
};

export type ThreeGazeFocusControls = {
  eyeYaw?: number; eyePitch?: number; headYaw?: number; headPitch?: number; headRoll?: number;
  /** Animation-sampled contributions in [0, 1], overriding request values. */
  eyeIntensity?: number; headIntensity?: number;
};

export type ThreeGazeFocusDiagnostic = {
  target: Point;
  eyes: Array<{ name: string; origin: Point; direction: Point; errorDegrees: number; limited: boolean }>;
  headLimited: boolean;
  missingHead: boolean;
  missingEyes: boolean;
};

const EPSILON = 1e-8;
const finite = (value: unknown, fallback = 0) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const bounded = (value: number) => Math.max(-1, Math.min(1, finite(value)));
const contribution = (value: unknown) => Math.max(0, Math.min(1, finite(value, 1)));
const point = (value: Vector3): Point => ({ x: value.x, y: value.y, z: value.z });
const vector = (value: Point) => new Vector3(finite(value?.x), finite(value?.y), finite(value?.z));
const axisVector = (channel: string) => channel === 'rx' ? new Vector3(1, 0, 0)
  : channel === 'ry' ? new Vector3(0, 1, 0) : channel === 'rz' ? new Vector3(0, 0, 1) : undefined;

/**
 * A renderer constraint, driven by Animation's existing motor controls. It owns
 * no clock, camera, target-selection policy, or event loop. Call restore before
 * evaluating the mixer (and before changing bindings), then apply afterwards.
 * Keeping the evaluated base pose separate prevents corrections feeding back
 * through Three's unchanged-property optimization on paused/constant clips.
 *
 * Optional profile.gazeCalibration.{head,leftEye,rightEye}.opticalAxis supplies
 * a bone-local optical direction. Otherwise signed yaw/pitch bindings determine
 * it: CC4's eye rz/negative-rx axes yield -Y; head ry/negative-rx yield +Z.
 */
export class ThreeGazeFocus {
  private head?: Joint;
  private eyes: Joint[] = [];
  private saved = new Map<Object3D, { base: Quaternion; applied: Quaternion }>();
  private references: ReadonlyMap<Object3D, ThreeReferencePoseNode>;
  private limits: { headYaw: Limits; headPitch: Limits; eyeYaw: Limits; eyePitch: Limits };

  constructor(private model: Object3D, private profile: any, options: ThreeGazeFocusOptions = {}) {
    this.references = bindModelReferencePose(model, options.referencePose ?? captureModelReferencePose(model));
    this.head = this.joint('HEAD', 'head', [51, 52, 53, 54, 56, 55]);
    this.eyes = [this.joint('EYE_L', 'leftEye', [61, 62, 63, 64]),
      this.joint('EYE_R', 'rightEye', [61, 62, 63, 64])].filter((value): value is Joint => !!value);
    this.limits = {
      headYaw: this.capacity(51, 52), headPitch: this.capacity(53, 54),
      eyeYaw: this.capacity(61, 62), eyePitch: this.capacity(63, 64),
    };
  }

  private name(node: string) {
    const base = this.profile.boneNodes?.[node] ?? node;
    const prefix = this.profile.bonePrefix ?? '';
    const suffix = this.profile.boneSuffix ?? '';
    return `${base.startsWith(prefix) ? '' : prefix}${base}${base.endsWith(suffix) ? '' : suffix}`;
  }

  private binding(node: string, id: number): AxisBinding | undefined {
    const binding = this.profile.auToBones?.[id]?.find((candidate: any) => this.name(candidate.node) === this.name(node));
    const axis = binding && axisVector(binding.channel);
    const radians = finite(binding?.maxDegrees) * finite(binding?.scale, 1) * Math.PI / 180;
    return axis && Math.abs(radians) > EPSILON ? { axis, radians } : undefined;
  }

  private capacity(positive: number, negative: number): Limits {
    const magnitude = (id: number) => {
      const seen = new Set<string>();
      const values: number[] = [];
      for (const row of this.profile.auToBones?.[id] ?? []) {
        const name = this.name(row.node);
        if (!axisVector(row.channel) || seen.has(name)) continue;
        seen.add(name);
        values.push(Math.abs(finite(row.maxDegrees) * finite(row.scale, 1)));
      }
      return values.length ? Math.min(...values) : 0;
    };
    return { positive: magnitude(positive), negative: magnitude(negative) };
  }

  private joint(node: string, calibration: string, ids: number[]): Joint | undefined {
    const object = this.model.getObjectByName(this.name(node));
    if (!object) return undefined;
    const yaw = { positive: this.binding(node, ids[0]), negative: this.binding(node, ids[1]) };
    const pitch = { positive: this.binding(node, ids[2]), negative: this.binding(node, ids[3]) };
    const roll = { positive: this.binding(node, ids[4]), negative: this.binding(node, ids[5]) };
    const explicit = this.profile.gazeCalibration?.[calibration]?.opticalAxis;
    let optical = explicit ? vector(explicit) : new Vector3();
    if (optical.lengthSq() < EPSILON) {
      const positiveAxis = (axis: Axis) => axis.positive
        ? axis.positive.axis.clone().multiplyScalar(Math.sign(axis.positive.radians))
        : axis.negative?.axis.clone().multiplyScalar(-Math.sign(axis.negative.radians));
      const yawAxis = positiveAxis(yaw);
      const pitchAxis = positiveAxis(pitch);
      if (yawAxis && pitchAxis) optical.crossVectors(yawAxis, pitchAxis);
    }
    // Unknown optical frames are deliberately left untouched, not guessed.
    if (optical.lengthSq() < EPSILON) return undefined;
    const reference = this.references.get(object)!;
    const ancestors: Object3D[] = [];
    for (let parent = object.parent; parent && parent !== this.model; parent = parent.parent) ancestors.push(parent);
    const referenceParent = new Matrix4();
    for (const parent of ancestors.reverse()) referenceParent.multiply(new Matrix4().fromArray(this.references.get(parent)!.localMatrix));
    const rotation = reference.transform.rotation;
    return { object, optical: optical.normalize(), yaw, pitch, roll,
      reference: new Quaternion(rotation.x, rotation.y, rotation.z, rotation.w),
      referenceParent, referenceScale: vector(reference.transform.scale) };
  }

  restore() {
    for (const [object, value] of this.saved) {
      // Preserve a newer authored/direct runtime write between mixer ticks.
      if (Math.abs(object.quaternion.dot(value.applied)) > 1 - 1e-12) object.quaternion.copy(value.base);
    }
    this.saved.clear();
    this.model.updateMatrixWorld(true);
  }

  private controlLimits() {
    const combine = (head: Limits, eye: Limits): Limits => ({
      negative: head.negative + eye.negative,
      positive: head.positive + eye.positive,
    });
    return { yaw: combine(this.limits.headYaw, this.limits.eyeYaw), pitch: combine(this.limits.headPitch, this.limits.eyePitch) };
  }

  private angles(direction: Vector3) {
    const local = direction.clone().applyQuaternion(this.model.getWorldQuaternion(new Quaternion()).invert());
    return { yaw: Math.atan2(local.x, local.z) * 180 / Math.PI,
      pitch: Math.atan2(local.y, Math.hypot(local.x, local.z)) * 180 / Math.PI };
  }

  private ratio(degrees: number, limits: Limits) {
    const capacity = degrees < 0 ? limits.negative : limits.positive;
    return capacity > EPSILON ? bounded(degrees / capacity) : 0;
  }

  private degrees(control: number, limits: Limits) {
    return bounded(control) * (control < 0 ? limits.negative : limits.positive);
  }

  private direction(yawDegrees: number, pitchDegrees: number) {
    const yaw = yawDegrees * Math.PI / 180;
    const pitch = pitchDegrees * Math.PI / 180;
    return new Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch))
      .applyQuaternion(this.model.getWorldQuaternion(new Quaternion())).normalize();
  }

  private ray(joint: Joint) {
    return joint.optical.clone().transformDirection(joint.object.matrixWorld);
  }

  /** Seed motor clips from the rendered bearing when enabling pose constraints. */
  readControlState(options: Flags & {
    worldTarget?: Point; headIntensity?: number; eyeIntensity?: number;
    headBaseQuaternion?: Rotation; eyeBaseQuaternions?: Record<string, Rotation>;
  } = {}) {
    this.model.updateMatrixWorld(true);
    const active = this.controlLimits();
    const gaze = new Vector3();
    const eyeBases = new Map<Joint, { base: Quaternion; actual: Vector3 }>();
    const eyeGain = contribution(options.eyeIntensity);
    for (const eye of this.eyes) {
      const value = options.eyeBaseQuaternions?.[eye.object.name];
      const base = value
        ? new Quaternion(finite(value.x), finite(value.y), finite(value.z), finite(value.w, 1)).normalize()
        : (this.saved.get(eye.object)?.base ?? eye.object.quaternion).clone();
      const actual = this.ray(eye);
      const excursion = this.solveJoint(eye, actual, 0, base);
      gaze.add(this.jointPose(eye, base,
        eyeGain > EPSILON ? bounded(excursion.yaw / eyeGain) : 0,
        eyeGain > EPSILON ? bounded(excursion.pitch / eyeGain) : 0).direction);
      eyeBases.set(eye, { base, actual });
    }
    if (gaze.lengthSq() < EPSILON) gaze.copy(this.head ? this.ray(this.head) : this.direction(0, 0));
    const eyes = this.angles(gaze.normalize());
    let head = this.angles(this.direction(0, 0));
    let headSeedLimited = false;
    if (this.head) {
      const value = options.headBaseQuaternion;
      const base = value
        ? new Quaternion(finite(value.x), finite(value.y), finite(value.z), finite(value.w, 1)).normalize()
        : (this.saved.get(this.head.object)?.base ?? this.head.object.quaternion).clone();
      const actual = this.ray(this.head);
      const excursion = this.solveJoint(this.head, actual, 0, base);
      const gain = contribution(options.headIntensity);
      const yaw = gain > EPSILON ? bounded(excursion.yaw / gain) : 0;
      const pitch = gain > EPSILON ? bounded(excursion.pitch / gain) : 0;
      const preferred = this.jointPose(this.head, this.head.reference, yaw, pitch, 0,
        this.referenceParent(this.head), this.head.referenceScale);
      head = this.angles(preferred.direction);
      const represented = this.direction(
        this.degrees(this.ratio(head.yaw, this.limits.headYaw), this.limits.headYaw),
        this.degrees(this.ratio(head.pitch, this.limits.headPitch), this.limits.headPitch),
      );
      headSeedLimited = this.contributedPose(this.head, represented, 0, gain, true, base).direction.angleTo(actual) > 0.001;
    }
    const destination = options.worldTarget ? this.angles(vector(options.worldTarget).sub(this.origin())) : undefined;
    const eyeTarget = { x: -this.ratio(eyes.yaw, active.yaw), y: this.ratio(eyes.pitch, active.pitch), z: 0 };
    // A shared finite target cannot represent every pair of legacy eye poses
    // (in particular parallel rays). Report that residual rather than claiming
    // the inverse contribution guarantees an exact binocular handoff.
    const origin = this.origin();
    const distance = options.worldTarget ? Math.max(EPSILON, vector(options.worldTarget).distanceTo(origin)) : 1;
    const representedTarget = origin.clone().addScaledVector(this.direction(
      this.degrees(-eyeTarget.x, active.yaw), this.degrees(eyeTarget.y, active.pitch)), distance);
    const eyeSeedLimited = this.eyes.some((eye) => {
      const { base, actual } = eyeBases.get(eye)!;
      const desired = representedTarget.clone().sub(eye.object.getWorldPosition(new Vector3())).normalize();
      return this.contributedPose(eye, desired, 0, eyeGain, false, base).direction.angleTo(actual) > 0.001;
    });
    return {
      target: destination ? { x: -this.ratio(destination.yaw, active.yaw), y: this.ratio(destination.pitch, active.pitch), z: 0 } : undefined,
      eyeTarget,
      headTarget: { x: -this.ratio(head.yaw, this.limits.headYaw), y: this.ratio(head.pitch, this.limits.headPitch), z: 0 },
      headRoll: 0,
      headSeedLimited,
      eyeSeedLimited,
    };
  }

  private origin() {
    const origin = new Vector3();
    for (const eye of this.eyes) origin.add(eye.object.getWorldPosition(new Vector3()));
    if (this.eyes.length) origin.divideScalar(this.eyes.length);
    else if (this.head) origin.copy(this.head.object.getWorldPosition(new Vector3()));
    else origin.copy(this.model.getWorldPosition(new Vector3()));
    return origin;
  }

  private rotation(axis: Axis, value: number) {
    const binding = value < 0 ? axis.negative : axis.positive;
    return binding ? new Quaternion().setFromAxisAngle(binding.axis, Math.abs(bounded(value)) * binding.radians) : new Quaternion();
  }

  private referenceParent(joint: Joint) {
    return new Matrix4().multiplyMatrices(this.model.matrixWorld, joint.referenceParent);
  }

  private jointPose(joint: Joint, base: Quaternion, yaw: number, pitch: number, roll = 0,
    parent = joint.object.parent?.matrixWorld ?? new Matrix4(), scale = joint.object.scale) {
    const object = joint.object;
    const quaternion = base.clone().multiply(this.rotation(joint.yaw, yaw))
      .multiply(this.rotation(joint.pitch, pitch)).multiply(this.rotation(joint.roll, roll));
    const matrix = new Matrix4().multiplyMatrices(parent, new Matrix4().compose(object.position, quaternion, scale));
    return { quaternion, direction: joint.optical.clone().transformDirection(matrix) };
  }

  private solveJoint(joint: Joint, desired: Vector3, roll = 0, base = joint.object.quaternion.clone(),
    parent = joint.object.parent?.matrixWorld ?? new Matrix4(), scale = joint.object.scale) {
    const evaluate = (yaw: number, pitch: number) => this.jointPose(joint, base, yaw, pitch, roll, parent, scale);
    let yaw = 0;
    let pitch = 0;
    let best = evaluate(yaw, pitch);
    // Two bounded actuator coordinates, with finite-difference Jacobians in
    // the actual hierarchy. This also handles noncanonical signed rig axes.
    for (let iteration = 0; iteration < 24; iteration += 1) {
      const error = desired.clone().sub(best.direction);
      if (error.lengthSq() < 1e-14) break;
      const derivative = (axis: 0 | 1) => {
        const value = axis === 0 ? yaw : pitch;
        const lo = Math.max(-1, value - 0.0001);
        const hi = Math.min(1, value + 0.0001);
        return evaluate(axis === 0 ? hi : yaw, axis === 1 ? hi : pitch).direction
          .sub(evaluate(axis === 0 ? lo : yaw, axis === 1 ? lo : pitch).direction).divideScalar(hi - lo);
      };
      const a = derivative(0);
      const b = derivative(1);
      const aa = a.dot(a) + 1e-7;
      const ab = a.dot(b);
      const bb = b.dot(b) + 1e-7;
      const determinant = aa * bb - ab * ab;
      if (determinant < 1e-14) break;
      const ay = a.dot(error);
      const by = b.dot(error);
      const dy = Math.max(-0.5, Math.min(0.5, (ay * bb - by * ab) / determinant));
      const dp = Math.max(-0.5, Math.min(0.5, (by * aa - ay * ab) / determinant));
      let improved = false;
      for (const step of [1, 0.5, 0.25, 0.125]) {
        const nextYaw = bounded(yaw + dy * step);
        const nextPitch = bounded(pitch + dp * step);
        const next = evaluate(nextYaw, nextPitch);
        if (next.direction.distanceToSquared(desired) < error.lengthSq()) {
          yaw = nextYaw; pitch = nextPitch; best = next; improved = true; break;
        }
      }
      if (!improved) break;
    }
    return { ...best, limited: best.direction.angleTo(desired) > 0.001, yaw, pitch };
  }

  private contributedPose(joint: Joint, desired: Vector3, roll: number, intensity: number, fromReference: boolean,
    base = joint.object.quaternion.clone()) {
    const full = fromReference
      ? this.solveJoint(joint, desired, roll, joint.reference, this.referenceParent(joint), joint.referenceScale)
      : this.solveJoint(joint, desired, roll, base);
    // Head gaze is an authored-reference excursion composed onto animation;
    // solving from the animated base would erase its gestures at full strength.
    // Eyes instead correct from that final pose toward one finite target.
    const gain = contribution(intensity);
    const result = this.jointPose(joint, base, full.yaw * gain, full.pitch * gain, bounded(roll) * gain);
    return { ...result, limited: result.direction.angleTo(desired) > 0.001 };
  }

  private solve(joint: Joint, desired: Vector3, roll = 0, intensity = 1, fromReference = false) {
    const result = this.contributedPose(joint, desired, roll, intensity, fromReference);
    this.saved.set(joint.object, { base: joint.object.quaternion.clone(), applied: result.quaternion.clone() });
    joint.object.quaternion.copy(result.quaternion);
    joint.object.updateMatrixWorld(true);
    return result;
  }

  apply(request: ThreeGazeFocusRequest, controls: ThreeGazeFocusControls): ThreeGazeFocusDiagnostic {
    // Idempotent even if a caller refreshes the constraint without a mixer tick.
    this.restore();
    const active = this.controlLimits();
    const intendedWorldTarget = vector(request.worldTarget);
    const origin = this.origin();
    const settled = Math.abs(finite(controls.eyeYaw) - finite(request.target?.x)) < 1e-5
      && Math.abs(finite(controls.eyePitch) - finite(request.target?.y)) < 1e-5;
    const target = settled ? intendedWorldTarget : origin.clone().addScaledVector(
      this.direction(this.degrees(-finite(controls.eyeYaw), active.yaw), this.degrees(finite(controls.eyePitch), active.pitch)),
      Math.max(EPSILON, origin.distanceTo(intendedWorldTarget)),
    );
    let headLimited = false;
    const headControlsPresent = controls.headYaw !== undefined || controls.headPitch !== undefined || controls.headRoll !== undefined;
    const eyeControlsPresent = controls.eyeYaw !== undefined || controls.eyePitch !== undefined;
    if (request.headEnabled !== false && headControlsPresent && this.head) {
      headLimited = this.solve(this.head, this.direction(
        this.degrees(-finite(controls.headYaw), this.limits.headYaw),
        this.degrees(finite(controls.headPitch), this.limits.headPitch),
      ), finite(controls.headRoll), contribution(controls.headIntensity ?? request.headIntensity), true).limited;
    }
    const eyes: ThreeGazeFocusDiagnostic['eyes'] = [];
    for (const eye of this.eyes) {
      const eyeOrigin = eye.object.getWorldPosition(new Vector3());
      const desired = target.clone().sub(eyeOrigin).normalize();
      const solved = request.eyesEnabled !== false && eyeControlsPresent
        ? this.solve(eye, desired, 0, contribution(controls.eyeIntensity ?? request.eyeIntensity)) : { limited: false };
      const direction = this.ray(eye);
      eyes.push({ name: eye.object.name, origin: point(eyeOrigin), direction: point(direction),
        errorDegrees: direction.angleTo(desired) * 180 / Math.PI, limited: solved.limited });
    }
    return { target: point(target), eyes, headLimited, missingHead: !this.head, missingEyes: this.eyes.length < 2 };
  }
}
