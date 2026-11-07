import { requireInitializedEmbodyCore } from './index';

export type GazeVector3 = readonly [number, number, number];
export type GazeQuaternion = readonly [number, number, number, number];
export interface GazeAnglesDegrees { pitch: number; yaw: number; roll: number }
export interface GazeGeometryInput {
  cameraPosition: GazeVector3;
  cameraQuaternion: GazeQuaternion;
  characterWorldQuaternion: GazeQuaternion;
  eyeOriginWorld: GazeVector3;
  verticalFovDegrees: number;
  aspect: number;
  target: { kind: 'screen'; x: number; y: number; depth?: number }
    | { kind: 'world'; position: GazeVector3 };
  targetRollDegrees?: number;
}
export interface GazeGeometryResult {
  targetAnglesDegrees: GazeAnglesDegrees;
  cameraAnglesDegrees: GazeAnglesDegrees;
  targetDirectionCharacter: [number, number, number];
  characterFacingCamera: boolean;
}
/** Requires initEmbodyCore(). Geometry only: the host owns planning and playback. */
export function solveGazeGeometry(input: GazeGeometryInput): GazeGeometryResult {
  // Native observations also carry identity/scale metadata. Only the declared
  // numeric geometry enters the strict Rust input schema.
  const { cameraPosition, cameraQuaternion, characterWorldQuaternion, eyeOriginWorld,
    verticalFovDegrees, aspect, target, targetRollDegrees } = input;
  return JSON.parse(requireInitializedEmbodyCore().solve_gaze_geometry(JSON.stringify({ cameraPosition, cameraQuaternion,
    characterWorldQuaternion, eyeOriginWorld, verticalFovDegrees, aspect, target, targetRollDegrees }))) as GazeGeometryResult;
}

export type GazeAxis = 'headYaw' | 'headPitch' | 'headRoll' | 'eyeYaw' | 'eyePitch';
export type GazeClipBinding = {
  snippet: { duration: number; curves: Record<string, readonly { time: number; intensity: number; inherit?: boolean }[]>; [key: string]: unknown };
  negativeTimeSec: number; neutralTimeSec: number; positiveTimeSec: number;
};
export type GazeBindingCalibration = Partial<Record<GazeAxis, {
  available: boolean;
  samples: Array<{ value: number; angleDegrees: number }>;
  reason?: string;
  /** Opaque, versioned numeric source/evaluator facts; interpreted only by Rust. */
  evaluator?: unknown;
}>>;
export type GazeBindingTargets = { targets: Partial<Record<GazeAxis, number>>; unavailableAxes: GazeAxis[] };
export interface GazeBindingTargetInput {
  headAnglesDegrees: GazeAnglesDegrees;
  eyeAnglesDegrees: Omit<GazeAnglesDegrees, 'roll'> & { roll?: number };
  headEnabled: boolean;
  eyesEnabled: boolean;
  headIntensity: number;
  eyeIntensity: number;
  intensity: number;
}
export function mapGazeAnglesToBindingTargets(calibration: GazeBindingCalibration, angles: Partial<Record<GazeAxis, number>>): GazeBindingTargets {
  return JSON.parse(requireInitializedEmbodyCore().map_gaze_angles_to_binding_targets(JSON.stringify(calibration), JSON.stringify(angles))) as GazeBindingTargets;
}
/** Desired source coordinates precede ordinary destination-strength scaling. */
export function solveGazeBindingTargets(calibration: GazeBindingCalibration, input: GazeBindingTargetInput): GazeBindingTargets & { residualAnglesDegrees: { yaw: number; pitch: number } } {
  return JSON.parse(requireInitializedEmbodyCore().solve_gaze_binding_targets(JSON.stringify(calibration), JSON.stringify(input))) as GazeBindingTargets & { residualAnglesDegrees: { yaw: number; pitch: number } };
}
