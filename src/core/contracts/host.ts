/**
 * Host adapter contracts (the TypeScript side of the ABI waist).
 *
 * Implementations live under `src/hosts/` (Three, Memory, …). They never put
 * engine objects into Wasm — only `ModelDescriptor`, control calls, and packed
 * FrameDelta / ClipIR cross the boundary. See docs/HOST_ABI.md.
 */
import type { ClipIR } from './clip';
import type { FrameDelta } from './frame';
import type { ModelDescriptor } from './model';

/** Read a host scene/model into a host-neutral descriptor for Wasm configure. */
export interface HostModelInspector<HostModel = unknown> {
  describeModel(model: HostModel): ModelDescriptor;
}

/** Write a FrameDelta (object form) onto host objects. Prefer packed appliers on hot paths. */
export interface HostFrameApplier<HostModel = unknown> {
  applyFrameDelta(model: HostModel, frame: FrameDelta): void;
}

export interface HostAnimationHandle {
  readonly id?: string;
  stop(): void;
  pause?(): void;
  resume?(): void;
  setWeight?(weight: number): void;
  setPlaybackRate?(playbackRate: number): void;
}

export interface HostAnimationPlayOptions {
  readonly weight?: number;
  readonly playbackRate?: number;
  readonly loop?: boolean;
  readonly startTimeSeconds?: number;
}

export interface HostAnimationSystem<
  HostModel = unknown,
  HostClip = unknown,
  AnimationHandle extends HostAnimationHandle = HostAnimationHandle,
> extends HostModelInspector<HostModel>, HostFrameApplier<HostModel> {
  createClip(model: HostModel, clip: ClipIR): HostClip;
  playClip(model: HostModel, clip: HostClip, options?: HostAnimationPlayOptions): AnimationHandle | null;
  update?(model: HostModel, deltaSeconds: number): void;
}
