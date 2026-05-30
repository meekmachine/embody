import type { BoneId, MeshId, MorphTargetId } from './ids';
import type { Transform } from './primitives';

export type FrameValueMode = 'absolute' | 'additive';
export type TransformSpace = 'local' | 'model';

export interface MorphTargetFrameDelta {
  readonly meshId: MeshId;
  readonly morphTargetId: MorphTargetId;
  readonly value: number;
  readonly mode?: FrameValueMode;
}

export interface BoneFrameDelta {
  readonly boneId: BoneId;
  readonly transform: Transform;
  readonly mode?: FrameValueMode;
  readonly space?: TransformSpace;
}

export interface MeshFrameDelta {
  readonly meshId: MeshId;
  readonly visible?: boolean;
}

export interface FrameDelta {
  readonly timeSeconds?: number;
  readonly deltaSeconds?: number;
  readonly morphTargets?: readonly MorphTargetFrameDelta[];
  readonly bones?: readonly BoneFrameDelta[];
  readonly meshes?: readonly MeshFrameDelta[];
}
