import type { BoneId, MeshId, MorphTargetId } from './ids';
import type { Transform } from './primitives';

export interface MorphTargetDescriptor {
  readonly id: MorphTargetId;
  readonly meshId: MeshId;
  readonly name: string;
  /** Host-local morph slot/index, recorded as data and not used as identity. */
  readonly hostIndex?: number;
}

export interface MeshDescriptor {
  readonly id: MeshId;
  readonly name: string;
  readonly parentBoneId?: BoneId;
  readonly morphTargetIds: readonly MorphTargetId[];
  readonly visible?: boolean;
}

export interface BoneDescriptor {
  readonly id: BoneId;
  readonly name: string;
  readonly parentId?: BoneId;
  readonly childIds: readonly BoneId[];
  readonly restTransform?: Transform;
}

export interface ModelDescriptor {
  readonly id?: string;
  readonly name?: string;
  readonly meshes: readonly MeshDescriptor[];
  readonly morphTargets: readonly MorphTargetDescriptor[];
  readonly bones: readonly BoneDescriptor[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}
