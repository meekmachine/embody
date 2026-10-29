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
      // Cloning the packed track first copies every morph's samples once per
      // component. Allocate only this component, including cubic tangents.
      const values = track.values.slice(0, track.times.length * parts);
      for (let sample = 0; sample < values.length; sample += 1) values[sample] = track.values[sample * width + component];
      const Track = track.constructor as typeof KeyframeTrack;
      const scalar = new Track(`${track.name}[${euler ? ['x', 'y', 'z'][component] : component}]`, track.times.slice(), values);
      // Match Three's clone contract: preserve the native interpolation factory.
      (scalar as KeyframeTrack & { createInterpolant: unknown }).createInterpolant =
        (track as KeyframeTrack & { createInterpolant: unknown }).createInterpolant;
      return scalar;
    });
  });
  if (!expanded) return clip;
  // The component tracks are already prepared; clip.clone() would clone the
  // original packed buffers again only to discard those cloned tracks.
  const Clip = clip.constructor as typeof AnimationClip;
  const indexed = new Clip(clip.name, clip.duration, tracks, clip.blendMode);
  indexed.userData = JSON.parse(JSON.stringify(clip.userData));
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
