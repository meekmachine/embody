import {
  AdditiveAnimationBlendMode,
  AnimationMixer,
  LoopOnce,
  LoopPingPong,
  LoopRepeat,
  NormalAnimationBlendMode,
} from 'three';
import type { AnimationAction, AnimationClip, KeyframeTrack, Object3D } from 'three';
import type { NativePlaybackSession } from '../wasm/index';
import { createAnimationClipFromClipIR, serializeAnimationClips } from './index';
import type { ClipIR, ThreeModelInspection } from './index';
import { bindPlaybackRendering } from './playbackRendering';
import { cloneWithConcreteTrackNames, withComponentTracks } from './clipBindings';

export type ThreeNativeLoop = { mode: 'once' | 'repeat' | 'pingPong'; count?: number | null };
export type ThreeNativePlaybackOptions = {
  replace?: string;
  startSeconds?: number;
  speed?: number;
  /** Native contribution only; semantic intensity belongs in the compiled clip. */
  weight?: number;
  blendMode?: 'normal' | 'additive';
  loop?: ThreeNativeLoop;
  finalPose?: 'release' | 'hold';
};
export type ThreeNativePlaybackControl =
  | { type: 'pause' | 'resume' | 'stop' }
  | { type: 'seek'; seconds: number }
  | { type: 'setSpeed'; speed: number }
  | { type: 'setWeight'; weight: number }
  | { type: 'setBlendMode'; blendMode: 'normal' | 'additive' }
  | { type: 'setLoop'; loop: ThreeNativeLoop }
  | { type: 'setFinalPose'; finalPose: 'release' | 'hold' }
  | { type: 'fadeIn' | 'fadeOut'; seconds: number };
export type ThreeNativePlaybackEvent =
  | { type: 'completed'; handle: string }
  | { type: 'cancelled'; handle: string; reason: string }
  | { type: 'error'; handle: string; message: string };
export type ThreeNativePlaybackBinding = {
  model: Object3D;
  inspection: ThreeModelInspection;
  /** Optional existing native mixer. Otherwise the connector owns one. */
  mixer?: AnimationMixer;
};
type BoundPlayback = ThreeNativePlaybackBinding & { mixer: AnimationMixer };

type Settings = Required<Omit<ThreeNativePlaybackOptions, 'replace'>>;
type Command =
  | { type: 'play'; handle: string; clip: ClipIR; settings: Settings }
  | { type: 'replaceClip'; handle: string; clip: ClipIR }
  | { type: 'control'; handle: string; control: ThreeNativePlaybackControl }
  | { type: 'release'; handle: string };
type Batch = { handle?: string; commands: Command[]; events: ThreeNativePlaybackEvent[] };
type NativeNotification = { type: 'completed' | 'cancelled' | 'error'; handle: string; message?: string };
type PausedFade = { seconds: number; from: number; to: number; weight: number };
type Resource = { clip: AnimationClip; action?: AnimationAction; binding: BoundPlayback; fadingOut?: boolean; pausedFade?: PausedFade; explicitlyPaused?: boolean; suspendedPaused?: boolean };
type PendingBatch = { batch: Batch; nextCommand: number; clip?: AnimationClip; afterCommands?: () => void };
type NativeInterpolant = { resultBuffer: unknown; settings?: unknown; valueSize: number };
type NativeTrack = KeyframeTrack & { createInterpolant: ((buffer: unknown) => NativeInterpolant) & { isInterpolantFactoryMethodGLTFCubicSpline?: boolean } };
type FadeInterpolant = { parameterPositions: ArrayLike<number>; sampleValues: { [index: number]: number }; evaluate(time: number): ArrayLike<number> };
type EditableAction = AnimationAction & { _interpolants: NativeInterpolant[]; _interpolantSettings: unknown; _weightInterpolant: FadeInterpolant | null };
const sampleSize = (track: KeyframeTrack) => track.getValueSize() / ((track as NativeTrack).createInterpolant.isInterpolantFactoryMethodGLTFCubicSpline ? 3 : 1);

const asError = (error: unknown): Error => error instanceof Error ? error : new Error(String(error));
const blendMode = (mode: 'normal' | 'additive') => mode === 'additive' ? AdditiveAnimationBlendMode : NormalAnimationBlendMode;
const loopMode = (mode: ThreeNativeLoop['mode']) => mode === 'once' ? LoopOnce : mode === 'repeat' ? LoopRepeat : LoopPingPong;

function validateBinding(binding: ThreeNativePlaybackBinding): void {
  if (!binding.model?.isObject3D || (binding.mixer && binding.mixer.getRoot() !== binding.model)) {
    throw new Error('Native playback requires a Three model and its render integration mixer.');
  }
  const objects = new Set<Object3D>();
  binding.model.traverse((object) => objects.add(object));
  const { inspection } = binding;
  for (const object of [
    ...inspection.meshBindings.values(), ...inspection.boneBindings.values(),
    ...inspection.objectBindings.values(), ...Array.from(inspection.morphBindings.values(), (entry) => entry.mesh),
  ]) {
    if (!objects.has(object)) throw new Error('Native playback inspection contains an object outside the bound model.');
  }
}

/**
 * Execute validated Rust commands on the native mixer. There is no
 * clock or update API. Each play owns a unique clip/action; other mixer users
 * remain untouched by stop, replacement, rebind and disposal.
 *
 * The connector owns the supplied Wasm session and frees it after successful
 * disposal. A failed release retains ownership and can be retried by dispose.
 */
export class ThreeNativePlaybackConnector {
  private binding: BoundPlayback;
  private rendering: ReturnType<typeof bindPlaybackRendering>;
  private renderingEnabled = true;
  private readonly resources = new Map<string, Resource>();
  private readonly actionHandles = new Map<AnimationAction, string>();
  private readonly listeners = new Set<(event: ThreeNativePlaybackEvent) => void>();
  private readonly pending: PendingBatch[] = [];
  private readonly notifications: NativeNotification[] = [];
  private depth = 0;
  private flushingNotifications = false;
  private notificationScheduled = false;
  private sessionDisposed = false;
  private disposed = false;
  private readonly onError?: (error: Error) => void;
  private readonly onRelease?: (handle: string) => void;

  constructor(
    private readonly session: NativePlaybackSession,
    binding: ThreeNativePlaybackBinding & { onError?: (error: Error) => void; onRelease?: (handle: string) => void },
  ) {
    validateBinding(binding);
    this.binding = { ...binding, mixer: binding.mixer ?? new AnimationMixer(binding.model) };
    this.onError = binding.onError;
    this.onRelease = binding.onRelease;
    this.binding.mixer.addEventListener('finished', this.finished);
    this.rendering = bindPlaybackRendering(binding.model, this.binding.mixer, () => this.flushEvents());
  }

  /** Prepare bindings first; old actions are released before the new binding is exposed. */
  rebind(modelKey: string, profileKey: string, binding: ThreeNativePlaybackBinding = this.binding): void {
    validateBinding(binding);
    this.beforeOperation();
    this.dispatch(this.session.rebind(modelKey, profileKey), undefined, () => {
      this.binding.mixer.removeEventListener('finished', this.finished);
      this.rendering.dispose();
      this.binding = { ...binding, mixer: binding.mixer ?? new AnimationMixer(binding.model) };
      this.binding.mixer.addEventListener('finished', this.finished);
      this.rendering = bindPlaybackRendering(binding.model, this.binding.mixer, () => this.flushEvents());
      this.rendering.setEnabled(this.renderingEnabled);
    });
  }

  play(clip: ClipIR, options: ThreeNativePlaybackOptions = {}): string {
    this.beforeOperation();
    const native = createAnimationClipFromClipIR(clip, this.binding.inspection);
    if (native.tracks.length !== clip.tracks.length) {
      throw new Error('Every playback track must resolve on the bound model.');
    }
    return this.dispatch(this.session.play(JSON.stringify(clip), JSON.stringify(options)), native).handle!;
  }

  /**
   * Validate native track bindings through the existing serializer, then retain
   * the native clone's interpolants and authored/additive sample values. Concrete
   * binding names match compiled tracks so Three shares their PropertyMixer.
   */
  playNativeClip(clip: AnimationClip, options: ThreeNativePlaybackOptions = {}): string {
    this.beforeOperation();
    clip = withComponentTracks(clip);
    const [ir] = serializeAnimationClips(this.binding.model, [clip], this.binding.inspection);
    if (ir.tracks.length !== clip.tracks.length) {
      throw new Error('Every native playback track must serialize against the bound model.');
    }
    const native = cloneWithConcreteTrackNames(clip, ir.tracks, this.binding.inspection);
    const settings = {
      ...options,
      blendMode: options.blendMode ?? (clip.blendMode === AdditiveAnimationBlendMode ? 'additive' : 'normal'),
    };
    return this.dispatch(this.session.play(JSON.stringify(ir), JSON.stringify(settings)), native).handle!;
  }

  control(handle: string, control: ThreeNativePlaybackControl): void {
    this.beforeOperation();
    this.dispatch(this.session.control(handle, JSON.stringify(control)));
  }

  setRendering(enabled: boolean): void {
    this.beforeOperation();
    if (enabled === this.renderingEnabled) return;
    this.renderingEnabled = enabled;
    this.rendering.setEnabled(enabled);
    for (const resource of this.resources.values()) {
      if (!resource.action) continue;
      if (!enabled) {
        resource.suspendedPaused = resource.action.paused;
        this.pauseFade(resource);
        resource.action.paused = true;
      } else if (resource.suspendedPaused !== undefined) {
        resource.action.paused = resource.suspendedPaused;
        if (!resource.explicitlyPaused) this.resumeFade(resource);
        resource.suspendedPaused = undefined;
      }
    }
  }

  setTimeScale(value: number): void {
    this.beforeOperation();
    if (!Number.isFinite(value)) throw new Error('Native mixer speed must be finite.');
    this.binding.mixer.timeScale = value;
  }

  fadeIn(handle: string, seconds: number): void { this.control(handle, { type: 'fadeIn', seconds }); }
  fadeOut(handle: string, seconds: number): void { this.control(handle, { type: 'fadeOut', seconds }); }

  /** Edit authored samples, retaining the native action and its loop/fade progress. */
  replaceClip(handle: string, clip: AnimationClip): void {
    this.beforeOperation();
    clip = withComponentTracks(clip);
    const resource = this.resources.get(handle);
    if (!resource) throw new Error('Unknown, foreign or stale playback handle.');
    const [ir] = serializeAnimationClips(this.binding.model, [clip], this.binding.inspection);
    if (ir.tracks.length !== clip.tracks.length) throw new Error('Every edited track must resolve on the bound model.');
    const native = cloneWithConcreteTrackNames(clip, ir.tracks, this.binding.inspection);
    if (native.tracks.length !== resource.clip.tracks.length || native.tracks.some((track, index) => {
      const old = resource.clip.tracks[index];
      return track.name !== old.name || track.ValueTypeName !== old.ValueTypeName || sampleSize(track) !== sampleSize(old);
    })) throw new Error('Editing samples must preserve track bindings; play a new clip to change its bindings.');
    const editable = resource.action as EditableAction | undefined;
    if (!editable || !Array.isArray(editable._interpolants) || editable._interpolants.length !== native.tracks.length) {
      throw new Error('This Three version does not support editing native action samples.');
    }
    this.dispatch(this.session.replace_clip(handle, JSON.stringify(ir)), native);
  }

  /** Native state for the owning adapter; never exposed through Polymer. */
  getAction(handle: string): AnimationAction | undefined {
    return this.resources.get(handle)?.action;
  }

  /** Deliver native completion after the borrowed mixer has finished sampling. */
  flushEvents(): void {
    if (this.disposed) return;
    this.notificationScheduled = false;
    for (const [handle, resource] of this.resources) {
      // Three evaluates fade weights on its mixer clock. Observe completion;
      // do not calculate a deadline or interpolate another weight here.
      if (resource.fadingOut && resource.action?.getEffectiveWeight() === 0) {
        resource.fadingOut = false;
        this.notifications.push({ type: 'cancelled', handle });
      }
    }
    this.flushNotifications();
  }

  subscribe(listener: (event: ThreeNativePlaybackEvent) => void): () => void {
    if (this.disposed) throw new Error('Native playback connector is disposed.');
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  dispose(): void {
    if (this.disposed) return;
    this.retryPending();
    if (!this.sessionDisposed) {
      const batch = this.session.dispose();
      this.sessionDisposed = true;
      this.dispatch(batch);
    }
    // A failed release throws above, leaving listeners, resources and session
    // owned until a later dispose successfully retries the remaining effects.
    this.binding.mixer.removeEventListener('finished', this.finished);
    this.rendering.dispose();
    this.notifications.length = 0;
    this.listeners.clear();
    this.session.free();
    this.disposed = true;
  }

  private pauseFade(resource: Resource): void {
    const action = resource.action as EditableAction | undefined;
    const fade = action?._weightInterpolant;
    if (!action || !fade) return;
    // Preserve Three's own fade segment. Mixer time remains its only clock.
    resource.pausedFade = {
      seconds: Math.max(0, fade.parameterPositions[1] - resource.binding.mixer.time),
      from: fade.evaluate(resource.binding.mixer.time)[0], to: fade.sampleValues[1], weight: action.weight,
    };
    action.stopFading();
    action.setEffectiveWeight(resource.pausedFade.weight * resource.pausedFade.from);
  }

  private resumeFade(resource: Resource): void {
    const action = resource.action as EditableAction | undefined;
    const fade = resource.pausedFade;
    if (!action || !fade) return;
    resource.pausedFade = undefined;
    action.setEffectiveWeight(fade.weight);
    action.fadeIn(fade.seconds);
    const interpolant = action._weightInterpolant!;
    interpolant.sampleValues[0] = fade.from;
    interpolant.sampleValues[1] = fade.to;
  }

  private beforeOperation(): void {
    if (this.disposed || this.sessionDisposed) throw new Error('Native playback connector is disposed.');
    this.retryPending();
  }

  private retryPending(): void {
    if (this.pending.length) this.drain();
  }

  private dispatch(serialized: string, clip?: AnimationClip, afterCommands?: () => void): Batch {
    const batch = JSON.parse(serialized) as Batch;
    this.pending.push({ batch, nextCommand: 0, clip, afterCommands });
    this.drain();
    return batch;
  }

  private drain(): void {
    const errors: Error[] = [];
    this.depth += 1;
    try {
      while (this.pending.length) {
        const pending = this.pending[0];
        while (pending.nextCommand < pending.batch.commands.length) {
          const command = pending.batch.commands[pending.nextCommand];
          try {
            this.execute(command, pending.clip);
          } catch (error) {
            // A release failure cannot be represented by a late terminal event.
            // Keep this command and its undelivered events available for retry.
            if (command.type === 'release') throw asError(error);
            const failure = asError(error);
            errors.push(failure);
            this.notifications.push({ type: 'error', handle: command.handle, message: failure.message || 'Native operation failed.' });
          }
          pending.nextCommand += 1;
        }
        pending.afterCommands?.();
        this.pending.shift();
        // Commands have finished before any observer may reenter playback.
        for (const event of pending.batch.events) {
          for (const listener of [...this.listeners]) {
            // An observer failure must not make a successful play look like an
            // allocation failure to its caller and orphan the new handle.
            try { listener(event); } catch (error) {
              const failure = asError(error);
              queueMicrotask(() => { if (this.onError) this.onError(failure); else throw failure; });
            }
          }
        }
      }
    } finally {
      this.depth -= 1;
    }
    if (this.depth === 0 && !this.flushingNotifications) this.flushNotifications();
    if (errors.length) throw errors[0];
  }

  private execute(command: Command, preparedClip?: AnimationClip): void {
    if (command.type === 'release') {
      const resource = this.resources.get(command.handle);
      if (!resource) return;
      resource.action?.stop();
      resource.binding.mixer.uncacheAction(resource.clip, resource.binding.model);
      resource.binding.mixer.uncacheClip(resource.clip);
      if (resource.action) this.actionHandles.delete(resource.action);
      this.resources.delete(command.handle);
      // Releasing a completed held pose is not a second terminal event. The
      // owning facade still needs to retire its resource bookkeeping.
      try { this.onRelease?.(command.handle); } catch (error) {
        const failure = asError(error);
        queueMicrotask(() => { if (this.onError) this.onError(failure); else throw failure; });
      }
      return;
    }
    if (command.type === 'replaceClip') {
      const resource = this.resources.get(command.handle);
      if (!resource || !preparedClip) throw new Error('Native clip edit has no owned resource.');
      // Three has no public action sample-edit method. Keep this adapter access
      // isolated: rebuild native interpolants with the existing PropertyMixer
      // result buffers, without reading or changing time, loop counters or fades.
      const action = resource.action as EditableAction;
      const tracks = preparedClip.tracks.map((track) => track.clone());
      const interpolants = tracks.map((track, index) => {
        const interpolant = (track as NativeTrack).createInterpolant(action._interpolants[index].resultBuffer);
        if (interpolant.settings) Object.assign(action._interpolantSettings as object, interpolant.settings);
        interpolant.settings = action._interpolantSettings;
        return interpolant;
      });
      resource.clip.tracks = tracks;
      action._interpolants = interpolants;
      return;
    }
    if (command.type === 'play') {
      if (!preparedClip) throw new Error('Native playback has no prepared clip.');
      const resource: Resource = { clip: preparedClip, binding: this.binding };
      this.resources.set(command.handle, resource);
      const settings = command.settings;
      const action = this.binding.mixer.clipAction(preparedClip, this.binding.model, blendMode(settings.blendMode));
      resource.action = action;
      this.actionHandles.set(action, command.handle);
      action.setLoop(loopMode(settings.loop.mode), settings.loop.count ?? Infinity);
      action.clampWhenFinished = settings.finalPose === 'hold';
      action.setEffectiveTimeScale(settings.speed);
      action.setEffectiveWeight(settings.weight);
      action.time = settings.startSeconds;
      if (!this.renderingEnabled) { resource.suspendedPaused = false; action.paused = true; }
      action.play();
      return;
    }
    const resource = this.resources.get(command.handle);
    const action = resource?.action;
    if (!resource || !action) throw new Error('Native playback action is unavailable.');
    const control = command.control;
    switch (control.type) {
      case 'pause':
        resource.explicitlyPaused = true;
        this.pauseFade(resource);
        action.paused = true;
        if (!this.renderingEnabled) this.resources.get(command.handle)!.suspendedPaused = true;
        break;
      case 'resume':
        resource.explicitlyPaused = false;
        if (this.renderingEnabled) { action.paused = false; this.resumeFade(resource); }
        else this.resources.get(command.handle)!.suspendedPaused = false;
        break;
      case 'seek': action.time = control.seconds; break;
      case 'setSpeed': action.setEffectiveTimeScale(control.speed); break;
      case 'setWeight':
        resource.pausedFade = undefined;
        action.setEffectiveWeight(control.weight);
        this.resources.get(command.handle)!.fadingOut = false;
        break;
      case 'setBlendMode': action.blendMode = blendMode(control.blendMode); break;
      case 'setLoop': action.setLoop(loopMode(control.loop.mode), control.loop.count ?? Infinity); break;
      case 'setFinalPose': action.clampWhenFinished = control.finalPose === 'hold'; break;
      case 'fadeIn':
        resource.pausedFade = undefined;
        action.fadeIn(control.seconds); resource.fadingOut = false;
        if (resource.explicitlyPaused || !this.renderingEnabled) this.pauseFade(resource);
        break;
      case 'fadeOut':
        resource.pausedFade = undefined;
        if (control.seconds === 0) this.notifications.push({ type: 'cancelled', handle: command.handle });
        else { action.fadeOut(control.seconds); resource.fadingOut = true; if (resource.explicitlyPaused || !this.renderingEnabled) this.pauseFade(resource); }
        break;
      case 'stop': throw new Error('Rust must translate stop into a resource release.');
    }
  }

  private readonly finished = (event: { action: AnimationAction }): void => {
    const handle = this.actionHandles.get(event.action);
    if (!handle || this.disposed) return;
    this.notifications.push({ type: this.resources.get(handle)?.fadingOut ? 'cancelled' : 'completed', handle });
    // Three dispatches finished while iterating its active action arrays.
    // Releasing/uncaching an action there would mutate that iteration.
    if (this.notificationScheduled) return;
    this.notificationScheduled = true;
    queueMicrotask(() => {
      this.notificationScheduled = false;
      if (this.disposed) return;
      try { this.flushNotifications(); } catch (error) {
        const failure = asError(error);
        if (this.onError) this.onError(failure);
        else throw failure;
      }
    });
  };

  private flushNotifications(): void {
    if (this.flushingNotifications || this.depth > 0 || this.disposed || this.notificationScheduled) return;
    this.flushingNotifications = true;
    try {
      while (this.notifications.length) {
        const event = this.notifications.shift()!;
        this.dispatch(this.session.notify(JSON.stringify(event)));
      }
    } finally {
      this.flushingNotifications = false;
    }
  }
}
