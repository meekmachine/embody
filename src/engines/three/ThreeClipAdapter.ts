import {
  AnimationClip,
  NumberKeyframeTrack,
  QuaternionKeyframeTrack,
  VectorKeyframeTrack,
} from 'three';
import type { Object3D } from 'three';
import type {
  BoneId,
  ClipIR,
  ClipTrackIR,
  MeshId,
  MorphTargetId,
  NumericArray,
} from '../../core/contracts';

export interface ThreeClipMeshBinding {
  readonly trackName: string;
}

export interface ThreeClipMorphTargetBinding {
  readonly meshId: MeshId;
  readonly index: number;
}

export interface ThreeClipAdapterBindings {
  readonly meshes?: ReadonlyMap<MeshId, Object3D | ThreeClipMeshBinding>;
  readonly morphTargets?: ReadonlyMap<MorphTargetId, ThreeClipMorphTargetBinding>;
  readonly bones?: ReadonlyMap<BoneId, Object3D | string>;
}

export class ThreeClipAdapter {
  private meshes = new Map<MeshId, Object3D | ThreeClipMeshBinding>();
  private morphTargets = new Map<MorphTargetId, ThreeClipMorphTargetBinding>();
  private bones = new Map<BoneId, Object3D | string>();

  constructor(bindings: ThreeClipAdapterBindings = {}) {
    this.setBindings(bindings);
  }

  setBindings(bindings: ThreeClipAdapterBindings): void {
    this.meshes = new Map(bindings.meshes || []);
    this.morphTargets = new Map(bindings.morphTargets || []);
    this.bones = new Map(bindings.bones || []);
  }

  toAnimationClip(clip: ClipIR): AnimationClip {
    return new AnimationClip(
      clip.name,
      clip.durationSeconds,
      clip.tracks.map((track) => this.toKeyframeTrack(track)).filter((track): track is NonNullable<typeof track> => !!track)
    );
  }

  private toKeyframeTrack(track: ClipTrackIR) {
    if (track.target.kind === 'morphTarget') {
      const morph = this.morphTargets.get(track.target.morphTargetId);
      const mesh = this.meshes.get(track.target.meshId);
      if (!morph || !mesh) return null;
      return new NumberKeyframeTrack(
        `${getTrackName(mesh)}.morphTargetInfluences[${morph.index}]`,
        toArray(track.times),
        toArray(track.values)
      );
    }

    if (track.target.kind === 'boneTransform') {
      const bone = this.bones.get(track.target.boneId);
      if (!bone) return null;
      const targetName = getTrackName(bone);
      const times = toArray(track.times);
      const values = toArray(track.values);

      if (track.target.property === 'rotation') {
        return new QuaternionKeyframeTrack(`${targetName}.quaternion`, times, values);
      }
      if (track.target.property === 'position') {
        return new VectorKeyframeTrack(`${targetName}.position`, times, values);
      }
      return new VectorKeyframeTrack(`${targetName}.scale`, times, values);
    }

    if (track.target.kind === 'meshVisibility') {
      const mesh = this.meshes.get(track.target.meshId);
      if (!mesh) return null;
      return new NumberKeyframeTrack(`${getTrackName(mesh)}.visible`, toArray(track.times), toArray(track.values));
    }

    return null;
  }
}

function getTrackName(value: Object3D | string | ThreeClipMeshBinding): string {
  if (typeof value === 'string') return value;
  if ('trackName' in value) return value.trackName;
  return value.uuid || value.name;
}

function toArray(values: NumericArray): number[] {
  return Array.from(values);
}
