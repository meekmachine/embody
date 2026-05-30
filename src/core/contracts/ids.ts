/**
 * Stable numeric identifiers used by host-neutral model, frame, and clip
 * contracts. Adapters assign these ids while inspecting a host model and keep
 * them stable for the lifetime of that descriptor.
 */
type StableNumericId<Tag extends string> = number & { readonly __embodyStableId: Tag };

export type MeshId = StableNumericId<'mesh'>;
export type MorphTargetId = StableNumericId<'morphTarget'>;
export type BoneId = StableNumericId<'bone'>;
export type TrackId = StableNumericId<'track'>;
export type ChannelId = StableNumericId<'channel'>;

export type HostTargetId = MeshId | MorphTargetId | BoneId;
