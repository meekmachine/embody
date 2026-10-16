/** Renderer-neutral channel metadata from Rust's `src/clip.rs`. */
export type ClipIRChannel = {
  id: number;
  kind: string;
  name?: string;
};

/**
 * Stable model descriptor IDs identify concrete outputs, not engine objects.
 * These are the existing concrete fields understood by the Three connector.
 * Rust carries the target as JSON; other connectors may extend this shape.
 */
export type ClipIRTarget = {
  kind?: string;
  meshId?: number;
  morphTargetId?: number;
  boneId?: number;
  objectId?: number;
  property?: string;
};

export type ClipIRTrack = {
  /** Rust emits both IDs; optionality preserves existing adapter inputs. */
  id?: number;
  channelId?: number;
  target: ClipIRTarget;
  /** Rust's standard concrete value types are scalar, vec3 and quat. */
  valueType: string;
  /** Keyframe times in seconds. Values are flattened in time order. */
  times: number[];
  values: number[];
  interpolation?: string;
  /** Capture the bound property's current value when materializing the clip. */
  inheritStart?: boolean;
  sourceName?: string;
};

/**
 * Host-neutral compiled clip data. Rust always emits durationSeconds, channels
 * and track IDs. They remain optional here for compatibility with existing
 * callers that construct minimal ClipIR for a renderer adapter.
 *
 * These declarations describe data; parsing JSON still requires validation at
 * the compiler/connector boundary. They add no playback state or frame driver.
 */
export type ClipIR = {
  id?: string;
  name: string;
  durationSeconds?: number;
  channels?: ClipIRChannel[];
  tracks: ClipIRTrack[];
  metadata?: unknown;
};
