import type { BoneResolutionProfile } from './adapter';

/**
 * Embody serializes bone-resolution inputs into Wasm. Passing a complete
 * character profile also serializes authored vertex deltas and saved clips
 * for every annotation lookup, even though the resolver cannot use them.
 */
export function boneResolutionProfile(
  profile: BoneResolutionProfile | null | undefined,
): BoneResolutionProfile | null {
  if (!profile) return null;
  return {
    bonePrefix: profile.bonePrefix,
    boneSuffix: profile.boneSuffix,
    boneNodes: profile.boneNodes,
    suffixPattern: profile.suffixPattern,
  };
}
