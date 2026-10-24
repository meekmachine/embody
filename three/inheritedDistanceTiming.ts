import { AdditiveAnimationBlendMode, NumberKeyframeTrack } from 'three';
import type { AnimationAction } from 'three';

/** Normalized AU units per native playback second; linear travel only. */
export type DistanceTimingOptions = {
  unitsPerSecond: number;
  minimumDurationSec?: number;
  reversalExtraSec?: number;
};

type Options = Record<string, any>;
type Point = { time: number; intensity: number; inherit?: boolean };
type ScalarTrack = NumberKeyframeTrack & { createInterpolant(): { evaluate(time: number): ArrayLike<number> } };
// Immutable measurement metadata on the existing native Playback. These tracks
// have no clock, mixer binding, frame update or independently changing pose.
export type InheritedDistanceBasis = {
  readonly tracks: ReadonlyMap<string, NumberKeyframeTrack>;
  readonly bindingOptions: string;
};
export type DistancePredecessor = {
  basis?: InheritedDistanceBasis;
  action: AnimationAction;
  terminal: boolean;
};
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const fail = (message: string): never => { throw new Error(`distanceTiming: ${message}`); };
const bindingOptions = (options: Options, effectiveMixWeights: Readonly<Record<string, number>>): string => JSON.stringify([
  options.balance ?? 0,
  Object.entries(options.balanceMap ?? {}).sort(([a], [b]) => a.localeCompare(b)),
  Object.entries(effectiveMixWeights).sort(([a], [b]) => a.localeCompare(b)),
  options.meshNames ? [...options.meshNames].sort() : null,
]);

export function validateDistanceTiming(curves: unknown, options: Options): DistanceTimingOptions | undefined {
  const timing = options.distanceTiming;
  if (timing === undefined) return undefined;
  if (!timing || typeof timing !== 'object' || Array.isArray(timing) ||
      Object.keys(timing).some(key => !['unitsPerSecond', 'minimumDurationSec', 'reversalExtraSec'].includes(key)) ||
      !finite(timing.unitsPerSecond) || timing.unitsPerSecond <= 0 ||
      !finite(timing.minimumDurationSec ?? 0) || (timing.minimumDurationSec ?? 0) < 0 ||
      !finite(timing.reversalExtraSec ?? 0) || (timing.reversalExtraSec ?? 0) < 0) {
    fail('requires finite positive unitsPerSecond and nonnegative duration options.');
  }
  if (options.blendMode !== 'additive' || (options.easing !== undefined && options.easing !== 'linear') ||
      (options.loopMode !== undefined && options.loopMode !== 'once') || options.loop === true ||
      options.reverse === true || options.additiveReferenceTimeSec !== undefined ||
      options.snippetCategory === 'visemeSnippet' || options.semanticAnimation ||
      ['speed', 'playbackRate', 'rate', 'timeScale', 'mixerWeight'].some(key => options[key] !== undefined && options[key] !== 1) ||
      ['fadeInSec', 'fadeOutSec', 'crossfadeDuration', 'time', 'offsetSec'].some(key => options[key] !== undefined && options[key] !== 0)) {
    fail('requires linear additive once playback at unit native speed/weight, without fades, offsets or an explicit reference.');
  }
  if (!curves || typeof curves !== 'object' || Array.isArray(curves) || Object.keys(curves).length === 0 ||
      Object.entries(curves).some(([id, value]) => {
        const points = value as Point[];
        return !/^\d+$/.test(id) || String(Number(id)) !== id || !Number.isSafeInteger(Number(id)) || Number(id) > 0xffffffff ||
          !Array.isArray(points) || points.length !== 2 || points[0]?.time !== 0 || points[1]?.time !== 1 ||
          points[0]?.inherit !== true || points[1]?.inherit === true ||
          points.some(point => !finite(point?.intensity) || point.intensity < 0 || point.intensity > 2);
      })) fail('requires numeric AU curves with an inherited key at 0 and one destination key at nominal 1 second.');
  return timing as DistanceTimingOptions;
}

export function validateDistancePredecessor(curves: Record<string, Point[]>, options: Options,
  previous: DistancePredecessor | undefined, effectiveMixWeights: Readonly<Record<string, number>>): void {
  if (!previous) return;
  const { action, basis } = previous;
  const ids = Object.keys(curves);
  if (!basis || basis.tracks.size !== ids.length || ids.some(id => !basis.tracks.has(id)) ||
      basis.bindingOptions !== bindingOptions(options, effectiveMixWeights) || action.blendMode !== AdditiveAnimationBlendMode ||
      action.timeScale !== 1 || action.getEffectiveWeight() !== 1 || !finite(action.time) || action.time < 0) {
    fail('the same-name predecessor must retain the same AU keys/bindings and unit-weight native contribution.');
  }
}

/**
 * Rust's `RuntimeCore.measure_au_travel`: per-AU ids, current/destination
 * values and preceding travel in; `[distance, reversal ? 1 : 0]` out. The core
 * owns continuum pairing, so this adapter only samples native actions.
 */
export type MeasureAuTravel = (ids: Uint32Array, current: Float32Array, destination: Float32Array,
  precedingDelta: Float32Array) => Float32Array;

export function prepareDistanceTiming(
  curves: Record<string, Point[]>, options: Options, scale: number, previous: DistancePredecessor | undefined,
  measureAuTravel: MeasureAuTravel, effectiveMixWeights: Readonly<Record<string, number>> = {},
): { durationSec: number; basis: InheritedDistanceBasis } {
  const timing = validateDistanceTiming(curves, options)!;
  validateDistancePredecessor(curves, options, previous, effectiveMixWeights);
  const tracks = new Map<string, NumberKeyframeTrack>();
  const entries = Object.entries(curves);
  const ids = new Uint32Array(entries.length), current = new Float32Array(entries.length);
  const destination = new Float32Array(entries.length), precedingDelta = new Float32Array(entries.length);
  // Only travel of an unfinished predecessor can be reversed; a held one has none.
  const unfinished = !!previous && !previous.terminal && previous.action.time < previous.action.getClip().duration;
  entries.forEach(([id, points], index) => {
    const preceding = previous?.basis?.tracks.get(id);
    // Native interpolation reads the actual action's time. There is no manual
    // elapsed-time/phase calculation or reconstructed from/to pose here.
    const sample = preceding ? (preceding as ScalarTrack).createInterpolant().evaluate(previous!.action.time)[0] : 0;
    if (!finite(sample)) fail('the native AU interpolant returned an invalid sample.');
    ids[index] = Number(id);
    current[index] = sample;
    // Float32 storage matches native keyframes, so identical held goals
    // remain exactly zero-distance admissions.
    destination[index] = Math.max(0, Math.min(2, points[1].intensity * scale));
    precedingDelta[index] = preceding && unfinished ? preceding.values[1] - preceding.values[0] : 0;
    tracks.set(id, new NumberKeyframeTrack(`au:${id}`, [0, 1], [current[index], destination[index]]));
  });
  const [distance, reversed] = measureAuTravel(ids, current, destination, precedingDelta);
  if (!finite(distance)) fail('the AU travel measurement is not finite.');
  const reversal = reversed === 1;
  const durationSec = Math.fround(distance === 0 ? 1e-6 : Math.max(1e-6,
    Math.max(distance / timing.unitsPerSecond, timing.minimumDurationSec ?? 0) + (reversal ? timing.reversalExtraSec ?? 0 : 0)));
  if (!finite(durationSec) || durationSec <= 0) fail('the requested native duration is not finite native keyframe time.');
  for (const track of tracks.values()) track.times[1] = durationSec;
  return { durationSec, basis: { tracks, bindingOptions: bindingOptions(options, effectiveMixWeights) } };
}
