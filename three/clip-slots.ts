import {
  AdditiveAnimationBlendMode, AnimationClip, AnimationUtils, LoopOnce,
  NumberKeyframeTrack, Quaternion, QuaternionKeyframeTrack, VectorKeyframeTrack,
} from 'three';
import type { AnimationAction, AnimationMixer, Interpolant, KeyframeTrack } from 'three';

// A slot name is a caller-owned identity, such as one complete head AU clip.
// A generation identifies one admission to that slot. Completion means the
// native clip reached its end, not that the character achieved a behavioral
// goal such as eye contact; callers need a separate observation for that.
export type ThreeClipSlotEvent = {
  type: 'completed' | 'replaced' | 'removed' | 'disposed';
  name: string;
  generation: number;
};
// Each handle is tied to one generation. Its promise resolves once, including
// interruption, so an agency can retire scheduled work without maintaining a
// second animation clock. Old handles deliberately cannot control successors.
export type ThreeClipSlotHandle = {
  name: string;
  generation: number;
  finished: Promise<ThreeClipSlotEvent>;
  pause(): void;
  resume(): void;
  stop(): void;
};
type Sample = { type: string; values: number[] };
type Entry = {
  name: string; generation: number; order: number;
  action: AnimationAction; clip: AnimationClip; settled: boolean;
  resolve(event: ThreeClipSlotEvent): void;
};
// These values are identities in Three's ADDITIVE track space. Numeric/vector
// deltas add zero; rotations multiply by the identity quaternion (XYZW).
// They are not the rig's authored rest pose, which is supplied separately when
// converting an absolute compiled target into its additive contribution.
const neutral = (type: string, size: number) => type === 'quaternion'
  ? [0, 0, 0, 1] : Array<number>(size).fill(0);

// All sampling happens once at a command boundary. Three's own interpolants
// sample the outgoing concrete clip; no semantic AU state or authored scene pose
// is reverse-engineered, and no custom callback is installed on a track.
// `time` is AnimationAction.time in seconds, including native pause/hold state.
// The returned arrays are copied because an interpolant can reuse its result
// buffer. Slot ownership ends at concrete properties: this function never reads
// auToBones, chooses an AU, applies a strength, or solves an eye direction.
function sampleClip(clip: AnimationClip, time: number): Map<string, Sample> {
  const result = new Map<string, Sample>();
  for (const track of clip.tracks) {
    if (!['number', 'vector', 'quaternion'].includes(track.ValueTypeName)) {
      throw new Error(`Unsupported additive target track ${track.name}: ${track.ValueTypeName}.`);
    }
    const nativeTrack = track as KeyframeTrack & { createInterpolant(): Interpolant };
    const values = Array.from(nativeTrack.createInterpolant().evaluate(time) as ArrayLike<number>);
    if (!values.every(Number.isFinite)) throw new Error(`Non-finite target track ${track.name}.`);
    const prior = result.get(track.name);
    if (prior) {
      if (prior.type !== track.ValueTypeName || prior.values.length !== values.length) {
        throw new Error(`Incompatible duplicate target track ${track.name}.`);
      }
      // Separate mapped AU morph outputs can share a concrete property. Retain
      // the same additive accumulation as Three instead of losing one mapping.
      // Addition is sufficient for scalars/vectors. Quaternion multiplication
      // is ordered and noncommutative, so preserve the source track order.
      prior.values = prior.type === 'quaternion'
        ? new Quaternion().fromArray(prior.values).multiply(new Quaternion().fromArray(values)).toArray()
        : prior.values.map((value, index) => value + values[index]);
    } else result.set(track.name, { type: track.ValueTypeName, values });
  }
  return result;
}

/**
 * One ordinary additive action per named slot. Replacement samples only that
 * slot's current contribution, then creates native tracks to the compiled AU
 * target. The application's existing mixer owns every subsequent sample.
 *
 * Rust remains authoritative for AU-to-bone/morph mapping and authored rotation
 * order. This renderer helper only replaces an already compiled contribution.
 * Capturing the combined scene pose here would accidentally absorb an idle or
 * Prosodic nod into tracking, causing it to accumulate or survive cancellation.
 * Sampling this slot's own clip keeps those independently authored actions
 * outside its start value. One current entry per name also bounds action count
 * during high-frequency pointer or camera input.
 */
export class ThreeClipSlots {
  private readonly current = new Map<string, Entry>();
  private generation = 0;
  private disposed = false;
  private reordering = false;
  private finishQueued = false;
  private readonly finishedEntries = new Set<Entry>();

  constructor(private readonly mixer: AnimationMixer,
    private readonly onEvent?: (event: ThreeClipSlotEvent) => void) {
    mixer.addEventListener('finished', this.onFinished);
  }

  private assertLive() {
    if (this.disposed) throw new Error('ThreeClipSlots has been disposed.');
  }

  private settle(entry: Entry, type: ThreeClipSlotEvent['type']) {
    // A held clip may later be replaced or removed, but its completed promise
    // stays completed. Queue external listeners outside the mutation stack so
    // reentrant scheduling sees the new inventory, not a half-replaced entry.
    if (entry.settled) return;
    entry.settled = true;
    const event = { type, name: entry.name, generation: entry.generation };
    entry.resolve(event);
    queueMicrotask(() => this.onEvent?.(event));
  }

  private readonly onFinished = (event: { action: AnimationAction }) => {
    for (const entry of this.current.values()) {
      if (entry.action === event.action) this.finishedEntries.add(entry);
    }
    if (this.finishQueued) return;
    this.finishQueued = true;
    // Native finished fires before property bindings are applied. Delivery and
    // any action reordering must happen after the mixer finishes that sample.
    // Save entry identities rather than slot names: replacement between the
    // native event and this microtask must not complete the newer generation.
    queueMicrotask(() => {
      this.finishQueued = false;
      if (this.disposed) return;
      const entries = [...this.finishedEntries];
      this.finishedEntries.clear();
      for (const entry of entries) {
        if (this.current.get(entry.name) === entry) this.settle(entry, 'completed');
      }
      this.reorder();
    });
  };

  private drop(entry: Entry) {
    // Release both the action and clip caches; retaining stopped generations
    // would turn continuous retargeting into unbounded renderer allocations.
    // The caller re-evaluates the mixer after inventory changes so surviving
    // authored actions become visible immediately, including when paused.
    entry.action.stop();
    this.mixer.uncacheAction(entry.clip);
    this.mixer.uncacheClip(entry.clip);
    if (this.current.get(entry.name) === entry) this.current.delete(entry.name);
  }

  /**
   * Call after an unrelated authored action starts/stops, never each frame.
   * `order` selects the caller's composition order; name breaks ties stably.
   * For example, head and eye clips may share a custom mapped bone, so their
   * quaternion product must not depend on Three's action-array compaction.
   */
  reorder() {
    if (this.disposed || this.reordering || !this.current.size) return;
    this.reordering = true;
    try {
      const snapshots = [...this.current.values()]
        .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
        .map(entry => ({ entry, time: entry.action.time, paused: entry.action.paused,
          enabled: entry.action.enabled, timeScale: entry.action.timeScale }));
      // Three compacts action storage on removal. Public stop/play establishes
      // stable quaternion composition after normal authored clips. These slot
      // actions have unit weight and no fades/warps to recreate or extrapolate.
      for (const { entry } of snapshots) entry.action.stop();
      for (const { entry, time, paused, enabled, timeScale } of snapshots) {
        entry.action.time = time;
        entry.action.paused = paused;
        entry.action.enabled = enabled;
        entry.action.setEffectiveWeight(1).setEffectiveTimeScale(timeScale).play();
      }
      // A zero delta reapplies bindings without advancing the application's
      // clock. Restoring action.time above is inventory maintenance, not agency
      // seeking or a per-frame Polymer interpolation path.
      this.mixer.update(0);
    } finally { this.reordering = false; }
  }

  /**
   * Admit one constant compiled destination and travel to it over durationSec.
   * referenceClip must be compiled from the same channels at zero intensity
   * against the same authored reference pose; the rendered pose is not a valid
   * neutral reference. Recreate/release slots when the model/profile is rebound.
   */
  replace(name: string, target: AnimationClip, options: {
    durationSec: number; referenceClip: AnimationClip; order?: number;
  }): ThreeClipSlotHandle {
    this.assertLive();
    const { durationSec, referenceClip } = options;
    if (!name || !Number.isFinite(durationSec) || durationSec < 0) {
      throw new Error('Clip slot replacement requires a name and a nonnegative durationSec.');
    }
    // Validate target/reference compatibility before touching the old action.
    // This API authors travel itself, so accepting an already moving target
    // clip would give two competing meanings to its time axis. Every source
    // key must therefore describe the same endpoint, with finite components.
    const references = new Map(referenceClip.tracks.map(track => [track.name, track]));
    for (const track of target.tracks) {
      const reference = references.get(track.name);
      if (!reference || reference.ValueTypeName !== track.ValueTypeName) {
        throw new Error(`Clip slot ${name} has no authored neutral reference for ${track.name}.`);
      }
      const size = track.getValueSize();
      if (!size || !track.times.length || track.values.length < size) {
        throw new Error(`Clip slot ${name} contains an empty target track.`);
      }
      for (let index = 0; index < track.values.length; index++) {
        if (!Number.isFinite(track.values[index]) || track.values[index] !== track.values[index % size]) {
          throw new Error(`Clip slot ${name} requires constant target tracks.`);
        }
      }
    }
    // Convert only a clone: callers may reuse their canonical compiled clip.
    // At reference frame zero the 30-fps argument does not change the reference
    // instant. Three owns the subtraction/quaternion reference conversion.
    const additive = AnimationUtils.makeClipAdditive(target.clone(), 0, referenceClip, 30);
    const destination = sampleClip(additive, 0);
    const previous = this.current.get(name);
    // Unit-weight slot actions have no fade envelope to reconstruct. Sampling
    // their native tracks at their actual local time is their entire owned
    // contribution, even during repeated reversals or a paused transition.
    const start = previous ? sampleClip(previous.clip, previous.action.time) : new Map<string, Sample>();
    const tracks: KeyframeTrack[] = [];
    // Keep a valid positive native duration even for an immediate command;
    // that case writes the destination at both keys and starts already held.
    const duration = Math.max(durationSec, 1e-6);
    // Union is essential for profiles with changing output sets. A morph/bone
    // present only in the outgoing clip must travel back to additive identity,
    // while a newly mapped property starts at identity. Dropping old tracks
    // immediately would snap them; retaining their endpoint would strand them.
    for (const property of new Set([...start.keys(), ...destination.keys()])) {
      const from = start.get(property), to = destination.get(property);
      const shape = to ?? from!;
      if (from && to && (from.type !== to.type || from.values.length !== to.values.length)) {
        throw new Error(`Clip slot ${name} changed property shape for ${property}.`);
      }
      const first = from?.values ?? neutral(shape.type, shape.values.length);
      const last = to?.values ?? neutral(shape.type, shape.values.length);
      const values = [...(durationSec ? first : last), ...last];
      // Ordinary native track classes provide their own interpolation (slerp
      // for quaternion keys). No custom interpolant or update callback is
      // installed, and all later samples come from the existing mixer loop.
      const ctor = shape.type === 'quaternion' ? QuaternionKeyframeTrack
        : shape.type === 'vector' ? VectorKeyframeTrack : NumberKeyframeTrack;
      tracks.push(new ctor(property, [0, duration], values));
    }
    const generation = ++this.generation;
    const clip = new AnimationClip(`${name}:${generation}`, duration, tracks, AdditiveAnimationBlendMode);
    // Validate and construct everything before replacing the old action. Its
    // current local time comes only from Three, including pauses and retargets.
    if (previous) { this.settle(previous, 'replaced'); this.drop(previous); }
    let resolve!: (event: ThreeClipSlotEvent) => void;
    const finished = new Promise<ThreeClipSlotEvent>(done => { resolve = done; });
    const action = this.mixer.clipAction(clip);
    const entry: Entry = { name, generation, order: options.order ?? 0, clip, action, resolve, settled: false };
    this.current.set(name, entry);
    action.reset().setLoop(LoopOnce, 1).setEffectiveWeight(1).setEffectiveTimeScale(1);
    // Hold the destination as an ordinary additive action until a later
    // replacement/removal. A completion event is a lifecycle fact; no timer
    // estimates when the target should have arrived.
    action.clampWhenFinished = true;
    if (!durationSec) { action.time = duration; action.paused = true; }
    action.play(); this.reorder();
    if (!durationSec) queueMicrotask(() => {
      if (!this.disposed && this.current.get(name) === entry) this.settle(entry, 'completed');
    });
    // Identity guards prevent a late cancel, pause, or resume from an obsolete
    // scheduler request from affecting the latest clip in the same named slot.
    return { name, generation, finished,
      pause: () => { if (this.current.get(name) === entry) this.pause(name); },
      resume: () => { if (this.current.get(name) === entry) this.resume(name); },
      stop: () => { if (this.current.get(name) === entry) this.remove(name); },
    };
  }

  // Pause/resume only change native action state. A completed held action stays
  // held on resume; it must not replay its transition from the beginning.
  pause(name: string) { this.assertLive(); const entry = this.current.get(name); if (entry) entry.action.paused = true; }
  resume(name: string) {
    this.assertLive(); const entry = this.current.get(name);
    if (entry && entry.action.time < entry.clip.duration) entry.action.paused = false;
  }
  pauseAll() { for (const name of this.current.keys()) this.pause(name); }
  resumeAll() { for (const name of this.current.keys()) this.resume(name); }
  isSettled() {
    // Pausing mid-travel is not arrival. Inspect native endpoint state without
    // sampling a pose or inferring elapsed time from an external clock.
    return [...this.current.values()].every(entry => entry.action.paused && entry.action.time >= entry.clip.duration);
  }
  getState(name: string) {
    // This snapshot reports the renderer's own time/state for diagnostics.
    // It does not advance, seek, or manufacture progress for the consumer.
    const entry = this.current.get(name);
    return entry ? { name, actionId: `target:${entry.generation}`, time: entry.action.time,
      duration: entry.clip.duration, playing: entry.action.isRunning(), isPlaying: entry.action.isRunning(),
      isPaused: entry.action.paused, isHeld: entry.action.paused && entry.action.time >= entry.clip.duration,
      intensityScale: 1, blendMode: 'additive', loopMode: 'once' } : null;
  }
  remove(name: string) {
    // Removal is cancellation, not a new interpolated destination. Removing
    // only this slot preserves all other slots and ordinary authored actions.
    if (this.disposed) return;
    const entry = this.current.get(name);
    if (entry) { this.settle(entry, 'removed'); this.drop(entry); this.reorder(); this.mixer.update(0); }
  }
  clear() { for (const name of [...this.current.keys()]) this.remove(name); }
  dispose() {
    // Detach events before releasing actions. Queued completion work checks
    // disposed/current identity, and therefore cannot revive released slots.
    if (this.disposed) return;
    this.disposed = true;
    this.mixer.removeEventListener('finished', this.onFinished);
    for (const entry of [...this.current.values()]) { this.settle(entry, 'disposed'); this.drop(entry); }
    this.finishedEntries.clear();
    // Other authored actions may still own these property bindings. Apply
    // their surviving contribution now, even when the render loop is paused.
    this.mixer.update(0);
  }
}
