import type {
  ChannelId,
  ClipChannelIR,
  ClipIR,
  ClipInterpolation,
  ClipTrackTarget,
  ClipTrackValueType,
  NumericArray,
  TrackId,
} from './contracts';
import type { CurvePoint } from './types';
import type { EmbodyCoreWasmModule } from '../wasmTypes';

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

/**
 * Thin host facade over the Rust clip compiler (`compile_clip` /
 * `compile_clip_curves`). Callers pass the Wasm module from `initEmbodyCore()`.
 */
export class TsClipCompiler {
  constructor(private readonly core: EmbodyCoreWasmModule) {}

  compile(input: TsClipCompilerInput): ClipIR {
    return JSON.parse(this.core.compile_clip(JSON.stringify(input))) as ClipIR;
  }

  compileCurves(input: TsClipCurvesInput): ClipIR {
    return JSON.parse(this.core.compile_clip_curves(JSON.stringify(input))) as ClipIR;
  }
}

export function numericArrayToNumbers(values: NumericArray): number[] {
  return Array.from(values);
}
