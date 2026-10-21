import { PropertyBinding } from 'three';
import type { AnimationClip, KeyframeTrack } from 'three';
import type { ClipIRTrack, ThreeModelInspection } from './index';

/**
 * Packed morphs must share PropertyMixers with indexed compiled tracks. Euler
 * components avoid Euler.fromArray's incompatible mixer-buffer offset/order.
 */
export function withComponentTracks(clip: AnimationClip): AnimationClip {
  let expanded = false;
  const tracks = clip.tracks.flatMap((track) => {
    const parsed = PropertyBinding.parseTrackName(track.name);
    const euler = parsed.propertyName === 'rotation';
    if ((!euler && !['morphTargetInfluences', 'weights'].includes(parsed.propertyName)) || parsed.propertyIndex !== undefined) return [track];
    const cubic = (track as KeyframeTrack & {
      createInterpolant: { isInterpolantFactoryMethodGLTFCubicSpline?: boolean };
    }).createInterpolant.isInterpolantFactoryMethodGLTFCubicSpline === true;
    const parts = cubic ? 3 : 1;
    const width = track.getValueSize() / parts;
    if (!Number.isInteger(width) || width < 1 || (euler && width !== 3)) throw new Error(`Invalid component track ${JSON.stringify(track.name)}.`);
    expanded = true;
    return Array.from({ length: width }, (_, component) => {
      const scalar = track.clone();
      scalar.name = `${track.name}[${euler ? ['x', 'y', 'z'][component] : component}]`;
      // Keep tangent/value/tangent storage and the native interpolation factory.
      scalar.values = track.values.slice(0, track.times.length * parts);
      for (let sample = 0; sample < scalar.values.length; sample += 1) scalar.values[sample] = track.values[sample * width + component];
      return scalar;
    });
  });
  if (!expanded) return clip;
  const indexed = clip.clone();
  indexed.tracks = tracks;
  return indexed;
}

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
    if (property === 'eulerX' || property === 'eulerY' || property === 'eulerZ') return `${object.uuid}.rotation[${property.slice(-1).toLowerCase()}]`;
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
