import { requireInitializedEmbodyCore } from './index';

/** Decode retired named movements using historical profile metadata. Await initEmbodyCore first. */
export function decodeLegacyPose<T extends object>(pose: T, profile?: unknown): T {
  if (!(pose as { semanticPose?: unknown }).semanticPose) return pose;
  return JSON.parse(requireInitializedEmbodyCore().decode_legacy_pose(JSON.stringify(pose), JSON.stringify(profile ?? null))) as T;
}

/** Decode retired named animation tracks without changing the saved input or time units. */
export function decodeLegacyAnimation<T extends object>(animation: T, profile?: unknown): T {
  if (!(animation as { semanticAnimation?: unknown }).semanticAnimation) return animation;
  return JSON.parse(requireInitializedEmbodyCore().decode_legacy_animation(JSON.stringify(animation), JSON.stringify(profile ?? null))) as T;
}
