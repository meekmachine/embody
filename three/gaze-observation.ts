import { Vector3 } from 'three';
import type { Object3D } from 'three';

export type ThreeGazePoint = { x: number; y: number; z: number };
export type ThreeGazeObservedEye = {
  side: 'left' | 'right';
  name: string;
  origin: ThreeGazePoint;
  direction: ThreeGazePoint;
  angularErrorDeg: number;
};
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
 */
export class ThreeGazeObserver {
  private readonly eyes: Eye[];

  constructor(private readonly model: Object3D, profile: unknown) {
    const source = data(profile);
    const names = data(source.boneNodes);
    const characterization = data(source.humanoidCharacterization);
    const roles = data(characterization.roles);
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
          const driven = negative.length && positive.length
            ? negative.includes(id) !== positive.includes(id) : selector(axis.aus).includes(id);
          if (driven) responses += 1;
        }
      }
      return responses === 1;
    };
    const binding = (node: string, id: number): Vector3 | undefined => {
      const rows = data(source.auToBones)[id];
      const row = data(Array.isArray(rows) ? rows.find(value => {
        const candidate = data(value);
        return typeof candidate.node === 'string' && name(candidate.node) === name(node);
      }) : undefined);
      if (!active(node, id)) return undefined;
      const signedDegrees = number(row.maxDegrees) * number(row.scale, 1);
      if (!Number.isFinite(signedDegrees) || Math.abs(signedDegrees) < EPSILON) return undefined;
      const axis = row.channel === 'rx' ? new Vector3(1, 0, 0)
        : row.channel === 'ry' ? new Vector3(0, 1, 0) : row.channel === 'rz' ? new Vector3(0, 0, 1) : undefined;
      return axis?.multiplyScalar(Math.sign(signedDegrees));
    };
    this.eyes = (['left', 'right'] as const).map((side): Eye => {
      const node = side === 'left' ? 'EYE_L' : 'EYE_R';
      const eye: Eye = { side, name: name(node) };
      const positiveYaw = binding(node, 61);
      const negativeYaw = binding(node, 62);
      const positivePitch = binding(node, 63);
      const negativePitch = binding(node, 64);
      if (!positiveYaw && !negativeYaw && !positivePitch && !negativePitch) {
        return { ...eye, reason: 'missing-eye-mapping' };
      }
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
        // CC4 rz/negative-rx yields -Y; ry/negative-rx yields +Z.
        const yaw = positiveYaw ?? negativeYaw?.negate();
        const pitch = positivePitch ?? negativePitch?.negate();
        if (yaw && pitch) optical.crossVectors(yaw, pitch);
      }
      return Number.isFinite(optical.lengthSq()) && optical.lengthSq() >= EPSILON
        ? { ...eye, optical: optical.normalize() } : { ...eye, reason: 'unknown-optical-axis' };
    });
  }

  observe(worldTarget: ThreeGazePoint): ThreeGazeObservation {
    if (!finitePoint(worldTarget)) {
      return { status: 'unavailable', reason: 'invalid-target', angularErrorDeg: null, eyes: [] };
    }
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
      const desired = target.clone().sub(origin);
      if (!Number.isFinite(desired.lengthSq()) || desired.lengthSq() < EPSILON) {
        reason ??= desired.lengthSq() < EPSILON ? 'coincident-target' : 'invalid-target';
        continue;
      }
      const angularErrorDeg = direction.angleTo(desired) * 180 / Math.PI;
      eyes.push({ side: eye.side, name: object.name, origin: point(origin), direction: point(direction), angularErrorDeg });
    }
    return { status: reason ? 'unavailable' : 'available', reason,
      angularErrorDeg: reason ? null : Math.max(...eyes.map(eye => eye.angularErrorDeg)), eyes };
  }
}
