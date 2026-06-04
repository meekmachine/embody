import type {
  ChannelId,
  ClipChannelIR,
  ClipIR,
  ClipInterpolation,
  ClipTrackIR,
  ClipTrackTarget,
  ClipTrackValueType,
  NumericArray,
  TrackId,
} from './contracts';
import type { CurvePoint } from './types';

export interface TsClipCompilerKeyframe {
  readonly time: number;
  readonly value: number | readonly number[];
}

export interface TsClipCompilerTrackInput {
  readonly id?: TrackId;
  readonly channelId?: ChannelId;
  readonly target: ClipTrackTarget;
  readonly valueType: ClipTrackValueType;
  readonly keyframes: readonly TsClipCompilerKeyframe[];
  readonly interpolation?: ClipInterpolation;
}

export interface TsClipCompilerInput {
  readonly id?: string;
  readonly name: string;
  readonly durationSeconds?: number;
  readonly channels?: readonly ClipChannelIR[];
  readonly tracks: readonly TsClipCompilerTrackInput[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface TsClipCurveTarget {
  readonly channelId?: ChannelId;
  readonly target: ClipTrackTarget;
  readonly valueType?: Extract<ClipTrackValueType, 'scalar'>;
  readonly scale?: number;
  readonly interpolation?: ClipInterpolation;
}

export interface TsClipCurvesInput {
  readonly id?: string;
  readonly name: string;
  readonly curves: Record<string, readonly CurvePoint[]>;
  readonly targets: Record<string, TsClipCurveTarget | readonly TsClipCurveTarget[]>;
  readonly channels?: readonly ClipChannelIR[];
  readonly durationSeconds?: number;
  readonly intensityScale?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

const defaultChannelId = 1 as ChannelId;

export class TsClipCompiler {
  compile(input: TsClipCompilerInput): ClipIR {
    const channels = normalizeChannels(input.channels);
    const tracks = input.tracks.map((track, index) => this.compileTrack(track, index));
    return {
      id: input.id,
      name: input.name,
      durationSeconds: input.durationSeconds ?? inferDurationSeconds(tracks),
      channels,
      tracks,
      metadata: input.metadata,
    };
  }

  compileCurves(input: TsClipCurvesInput): ClipIR {
    const tracks: TsClipCompilerTrackInput[] = [];
    const intensityScale = input.intensityScale ?? 1;

    for (const [curveId, curve] of Object.entries(input.curves)) {
      const targets = input.targets[curveId];
      if (!targets || curve.length === 0) continue;

      const targetList = Array.isArray(targets) ? targets : [targets];
      for (const target of targetList) {
        const scale = (target.scale ?? 1) * intensityScale;
        tracks.push({
          channelId: target.channelId,
          target: target.target,
          valueType: target.valueType ?? 'scalar',
          interpolation: target.interpolation,
          keyframes: curve.map((point) => ({
            time: point.time,
            value: point.intensity * scale,
          })),
        });
      }
    }

    return this.compile({
      id: input.id,
      name: input.name,
      durationSeconds: input.durationSeconds,
      channels: input.channels,
      tracks,
      metadata: input.metadata,
    });
  }

  private compileTrack(track: TsClipCompilerTrackInput, index: number): ClipTrackIR {
    if (track.keyframes.length === 0) {
      throw new Error('ClipIR tracks require at least one keyframe.');
    }

    const valueSize = getValueSize(track.valueType);
    const times: number[] = [];
    const values: number[] = [];

    for (const keyframe of track.keyframes) {
      if (!Number.isFinite(keyframe.time) || keyframe.time < 0) {
        throw new Error(`Invalid keyframe time "${keyframe.time}".`);
      }

      times.push(keyframe.time);
      const encoded = encodeValue(keyframe.value, valueSize);
      values.push(...encoded);
    }

    return {
      id: track.id ?? ((index + 1) as TrackId),
      channelId: track.channelId ?? defaultChannelId,
      target: track.target,
      valueType: track.valueType,
      times,
      values,
      interpolation: track.interpolation,
    };
  }
}

function normalizeChannels(channels: readonly ClipChannelIR[] | undefined): readonly ClipChannelIR[] {
  if (channels && channels.length > 0) {
    return channels;
  }
  return [{ id: defaultChannelId, kind: 'face', name: 'default' }];
}

function inferDurationSeconds(tracks: readonly ClipTrackIR[]): number {
  let duration = 0;
  for (const track of tracks) {
    for (const time of track.times) {
      if (time > duration) {
        duration = time;
      }
    }
  }
  return duration;
}

function getValueSize(valueType: ClipTrackValueType): number {
  if (valueType === 'scalar') return 1;
  if (valueType === 'vec3') return 3;
  return 4;
}

function encodeValue(value: number | readonly number[], size: number): number[] {
  const values = Array.isArray(value) ? value : [value];
  if (values.length !== size) {
    throw new Error(`Expected ${size} values for keyframe, received ${values.length}.`);
  }
  for (const entry of values) {
    if (!Number.isFinite(entry)) {
      throw new Error(`Invalid keyframe value "${entry}".`);
    }
  }
  return [...values];
}

export function numericArrayToNumbers(values: NumericArray): number[] {
  return Array.from(values);
}
