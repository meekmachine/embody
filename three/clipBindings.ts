import type { AnimationClip } from 'three';
import type { ClipIRTrack, ThreeModelInspection } from './index';

/** One PropertyMixer cache key for every concrete renderer destination. */
export function concreteTrackName(target: ClipIRTrack['target'] | undefined, inspection: ThreeModelInspection): string | undefined {
  if (!target) return undefined;
  if (target.kind === 'morphTarget') {
    const binding = inspection.morphBindings.get(Number(target.morphTargetId));
    return binding && `${binding.mesh.uuid}.morphTargetInfluences[${binding.index}]`;
  }
  if (target.kind === 'boneTransform' || target.kind === 'objectTransform') {
    const object = target.kind === 'boneTransform'
      ? inspection.boneBindings.get(Number(target.boneId))
      : inspection.objectBindings.get(Number(target.objectId));
    const property = target.property ?? 'rotation';
    if (!object) return undefined;
    if (property === 'rotation' || property === 'quaternion') return `${object.uuid}.quaternion`;
    if (property === 'position' || property === 'scale') return `${object.uuid}.${property}`;
  }
  if (target.kind === 'meshVisibility') {
    const mesh = inspection.meshBindings.get(Number(target.meshId));
    return mesh && `${mesh.uuid}.visible`;
  }
  return undefined;
}

/** Retain authored samples and interpolants; normalize only cloned binding names. */
export function cloneWithConcreteTrackNames(clip: AnimationClip, tracks: readonly ClipIRTrack[], inspection: ThreeModelInspection): AnimationClip {
  const native = clip.clone();
  for (let index = 0; index < tracks.length; index += 1) {
    const name = concreteTrackName(tracks[index].target, inspection);
    if (!name) throw new Error('Every native playback track must resolve on the bound model.');
    native.tracks[index].name = name;
  }
  return native;
}
