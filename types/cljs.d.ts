export interface EmbodyClipEvent {
  type: string;
  clipName?: string;
  name?: string;
  currentTime?: number;
  time?: number;
  duration?: number;
  [key: string]: unknown;
}

export type EmbodyClipEventListener = (event: any) => void;

export interface EmbodyClipHandle {
  clipName: string;
  actionId?: string;
  play(): void;
  stop(): void;
  pause(): void;
  resume(): void;
  setWeight(weight: number): void;
  setPlaybackRate(rate: number): void;
  setLoop(mode: 'once' | 'repeat' | 'pingpong', repeatCount?: number): void;
  setTime(time: number): void;
  getTime(): number;
  getDuration(): number;
  subscribe(listener: EmbodyClipEventListener): () => void;
  finished: Promise<void>;
}

export interface EmbodyClipPlanPlayback {
  source?: string;
  loop: boolean;
  loopMode: 'once' | 'repeat' | 'pingpong';
  repeatCount?: number;
  reverse: boolean;
  weight: number;
  mixerWeight: number;
  rate: number;
  playbackRate: number;
  speed: number;
  startTime: number;
  blendMode?: string;
  easing?: string;
}

export interface EmbodyClipPlan {
  clipName: string;
  duration: number;
  keyframeTimes: number[];
  curveCount: number;
  keyframeCount: number;
  hasInheritedStart: boolean;
  inheritedCurveIds: string[];
  playback: EmbodyClipPlanPlayback;
}

export interface EmbodyAnimationConnector {
  buildClip?(clipName: string, curves: Record<string, unknown>, options?: any): unknown;
  playClip?(clipName: string, curves?: Record<string, unknown>, options?: any): unknown;
  stopClip?(clipName: string): void;
  pauseClip?(clipName: string): void;
  resumeClip?(clipName: string): void;
  setClipWeight?(clipName: string, weight: number): void;
  setClipPlaybackRate?(clipName: string, rate: number): void;
  setClipLoop?(clipName: string, mode: 'once' | 'repeat' | 'pingpong', repeatCount?: number): void;
  setClipTime?(clipName: string, time: number): void;
  getClipTime?(clipName: string): number;
  getClipDuration?(clipName: string): number;
  updateClipParams?(clipName: string, params: Record<string, unknown>): boolean;
  cleanupSnippet?(clipName: string): void;
  onCommand?(command: Record<string, unknown>): void;
  onState?(state: Record<string, unknown>): void;
}

export interface EmbodyAnimationRuntime {
  snapshot(): Record<string, unknown>;
  buildClip(
    clipName: string,
    curves: Record<string, unknown>,
    options?: Record<string, unknown>
  ): EmbodyClipHandle | null;
  playSnippet(
    clipName: string,
    curves: Record<string, unknown>,
    options?: Record<string, unknown>
  ): EmbodyClipHandle | null;
  acceptClipEvent(event: EmbodyClipEvent): boolean;
  cleanupSnippet(clipName: string): boolean;
  updateClipParams(clipName: string, params: Record<string, unknown>): boolean;
}

export function createAnimationRuntime(
  config?: Record<string, unknown> | null,
  connector?: EmbodyAnimationConnector | null
): EmbodyAnimationRuntime;

export function createClipPlan(
  clipName: string,
  curves: Record<string, unknown>,
  options?: Record<string, unknown> | null
): EmbodyClipPlan;

export function installEmbody(target?: Record<string, unknown>): {
  createAnimationRuntime: typeof createAnimationRuntime;
  createClipPlan: typeof createClipPlan;
};
