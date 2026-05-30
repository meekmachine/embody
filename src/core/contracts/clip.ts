import type { BoneId, ChannelId, MeshId, MorphTargetId, TrackId } from './ids';
import type { NumericArray } from './primitives';

export type ClipChannelKind = 'face' | 'body' | 'scene' | 'custom';
export type ClipTrackValueType = 'scalar' | 'vec3' | 'quat';
export type ClipInterpolation = 'step' | 'linear' | 'cubic';
export type ClipTrackTargetKind = 'morphTarget' | 'boneTransform' | 'meshVisibility';
export type ClipTrackTransformProperty = 'position' | 'rotation' | 'scale';

export interface ClipChannelIR {
  readonly id: ChannelId;
  readonly kind: ClipChannelKind;
  readonly name?: string;
}

export interface MorphTargetTrackTarget {
  readonly kind: 'morphTarget';
  readonly meshId: MeshId;
  readonly morphTargetId: MorphTargetId;
}

export interface BoneTransformTrackTarget {
  readonly kind: 'boneTransform';
  readonly boneId: BoneId;
  readonly property: ClipTrackTransformProperty;
}

export interface MeshVisibilityTrackTarget {
  readonly kind: 'meshVisibility';
  readonly meshId: MeshId;
}

export type ClipTrackTarget =
  | MorphTargetTrackTarget
  | BoneTransformTrackTarget
  | MeshVisibilityTrackTarget;

export interface ClipTrackIR {
  readonly id: TrackId;
  readonly channelId: ChannelId;
  readonly target: ClipTrackTarget;
  readonly valueType: ClipTrackValueType;
  readonly times: NumericArray;
  readonly values: NumericArray;
  readonly interpolation?: ClipInterpolation;
}

export interface ClipIR {
  readonly id?: string;
  readonly name: string;
  readonly durationSeconds: number;
  readonly channels: readonly ClipChannelIR[];
  readonly tracks: readonly ClipTrackIR[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}
