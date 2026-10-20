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
  return JSON.parse(requireInitializedEmbodyCore().solve_gaze_geometry(JSON.stringify(input))) as GazeGeometryResult;
}
