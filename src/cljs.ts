import type {
  ClipEvent,
  ClipEventListener,
  ClipHandle,
  ClipOptions,
  CurvePoint,
  CurvesMap,
  EmbodyAnimationRuntime,
  EmbodyAnimationRuntimeConnector,
} from './core/types';

type LoopMode = 'once' | 'repeat' | 'pingpong';
type RuntimeStatus = 'playing' | 'paused' | 'completed' | 'stopped';

type RuntimeOptions = {
  weight: number;
  rate: number;
  loopMode: LoopMode;
  loop: boolean;
  repeatCount?: number;
  reverse: boolean;
  source: string;
  startTime: number;
  [key: string]: unknown;
};

type RuntimeHandleState = {
  clipName: string;
  actionId?: string;
  duration: number;
  time: number;
  weight: number;
  rate: number;
  loopMode: LoopMode;
  loop: boolean;
  repeatCount?: number;
  reverse: boolean;
  source: string;
  status: RuntimeStatus;
  createdAt: number;
  updatedAt: number;
};

type RuntimeState = {
  handles: Record<string, RuntimeHandleState>;
  order: string[];
  eventCount: number;
  lastEvent: Record<string, unknown> | null;
  lastUpdatedTime: number | null;
  config: Record<string, unknown>;
};

type ConnectorFunction = (...args: unknown[]) => unknown;

const LOOP_MODES = new Set<LoopMode>(['once', 'repeat', 'pingpong']);

function nowMs(): number {
  return Date.now();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function numberOr(value: unknown, fallback: number): number {
  return finiteNumber(value) ? value : fallback;
}

function clamp(low: number, high: number, value: unknown): number {
  const next = numberOr(value, low);
  return Math.min(high, Math.max(low, next));
}

function keyToString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'symbol') return value.description ?? '';
  return '';
}

function getConnectorFunction(
  connector: EmbodyAnimationRuntimeConnector,
  name: string
): ConnectorFunction | null {
  const candidate = (connector as Record<string, unknown>)[name];
  return typeof candidate === 'function' ? candidate as ConnectorFunction : null;
}

function callFirst(
  connector: EmbodyAnimationRuntimeConnector,
  names: string[],
  ...args: unknown[]
): unknown {
  for (const name of names) {
    const callback = getConnectorFunction(connector, name);
    if (callback) {
      return callback(...args);
    }
  }
  return undefined;
}

function normalizePoint(point: unknown): CurvePoint {
  const source = isRecord(point) ? point : {};
  return {
    time: numberOr(source.time ?? source.t, 0),
    intensity: numberOr(source.intensity ?? source.v, 0),
    inherit: Boolean(source.inherit),
  };
}

function normalizeCurves(curves: CurvesMap): CurvesMap {
  if (!isRecord(curves)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(curves).map(([curveId, points]) => [
      keyToString(curveId),
      (Array.isArray(points) ? points : [])
        .map(normalizePoint)
        .sort((a, b) => a.time - b.time),
    ])
  );
}

function calculateDuration(curves: CurvesMap, fallback: unknown): number {
  return Object.values(curves).reduce((duration, points) => {
    const last = points[points.length - 1];
    return Math.max(duration, numberOr(last?.time, duration));
  }, numberOr(fallback, 0));
}

function normalizeLoopMode(options: Record<string, unknown>): LoopMode {
  const mode = options.loopMode ?? options.mixerLoopMode;
  if (typeof mode === 'string' && LOOP_MODES.has(mode as LoopMode)) {
    return mode as LoopMode;
  }
  return options.loop === false ? 'once' : 'repeat';
}

function normalizeOptions(options?: ClipOptions): RuntimeOptions {
  const source = isRecord(options) ? options : {};
  const loopMode = normalizeLoopMode(source);
  const rate = source.playbackRate ?? source.rate ?? source.speed;
  const weight = source.weight ?? source.intensity ?? source.mixerWeight;

  return {
    ...source,
    weight: Math.max(0, numberOr(weight, 1)),
    rate: Math.max(0, numberOr(rate, 1)),
    loopMode,
    loop: loopMode !== 'once',
    repeatCount: finiteNumber(source.repeatCount) ? source.repeatCount : undefined,
    reverse: Boolean(source.reverse),
    source: keyToString(source.source) || 'clip',
    startTime: Math.max(0, numberOr(source.startTime, 0)),
    balance: clamp(-1, 1, source.balance),
    jawScale: Math.max(0, numberOr(source.jawScale, 1)),
    intensityScale: Math.max(0, numberOr(source.intensityScale, 1)),
  };
}

function makeActionId(clipName: string): string {
  return `${clipName}#${nowMs()}-${Math.floor(Math.random() * 1_000_000)}`;
}

function emitCommand(
  connector: EmbodyAnimationRuntimeConnector,
  op: string,
  clipName: string,
  payload: Record<string, unknown> = {}
): Record<string, unknown> {
  const command = {
    type: 'clipCommand',
    op,
    clipName,
    timestamp: nowMs(),
    ...payload,
  };
  connector.onCommand?.(command);
  return command;
}

function emitState(connector: EmbodyAnimationRuntimeConnector, state: RuntimeState): void {
  connector.onState?.(snapshotState(state));
}

function snapshotState(state: RuntimeState): Record<string, unknown> {
  return {
    handles: Object.fromEntries(
      Object.entries(state.handles).map(([clipName, handle]) => [clipName, { ...handle }])
    ),
    order: [...state.order],
    eventCount: state.eventCount,
    lastEvent: state.lastEvent ? { ...state.lastEvent } : null,
    lastUpdatedTime: state.lastUpdatedTime,
    config: { ...state.config },
  };
}

export function createAnimationRuntime(
  config: Record<string, unknown> | null = null,
  connector: EmbodyAnimationRuntimeConnector | null = null
): EmbodyAnimationRuntime {
  const renderer = connector ?? {};
  const state: RuntimeState = {
    handles: {},
    order: [],
    eventCount: 0,
    lastEvent: null,
    lastUpdatedTime: null,
    config: isRecord(config) ? { ...config } : {},
  };
  const listeners = new Map<string, Set<ClipEventListener>>();
  const finishers = new Map<string, () => void>();

  const upsertHandle = (handle: RuntimeHandleState) => {
    state.handles[handle.clipName] = handle;
    if (!state.order.includes(handle.clipName)) {
      state.order.push(handle.clipName);
    }
    state.lastUpdatedTime = nowMs();
  };

  const updateHandle = (
    clipName: string,
    apply: (handle: RuntimeHandleState) => RuntimeHandleState
  ) => {
    const current = state.handles[clipName];
    if (!current) return;
    state.handles[clipName] = apply({ ...current, updatedAt: nowMs() });
    state.lastUpdatedTime = nowMs();
  };

  const removeHandle = (clipName: string) => {
    delete state.handles[clipName];
    state.order = state.order.filter((name) => name !== clipName);
    state.lastUpdatedTime = nowMs();
  };

  const notifyListeners = (clipName: string, event: ClipEvent) => {
    for (const listener of Array.from(listeners.get(clipName) ?? [])) {
      try {
        listener(event);
      } catch (error) {
        console.error('[Embody runtime] clip listener failed', error);
      }
    }
  };

  const resolveFinished = (clipName: string) => {
    const resolve = finishers.get(clipName);
    if (resolve) {
      resolve();
      finishers.delete(clipName);
    }
  };

  const makeHandle = (clipName: string): ClipHandle => {
    const finished = new Promise<void>((resolve) => {
      finishers.set(clipName, resolve);
    });

    return {
      clipName,
      actionId: state.handles[clipName]?.actionId,
      play: () => {
        updateHandle(clipName, (handle) => ({ ...handle, status: 'playing' }));
        emitCommand(renderer, 'play', clipName);
        callFirst(renderer, ['playClip', 'play'], clipName);
        emitState(renderer, state);
      },
      stop: () => {
        updateHandle(clipName, (handle) => ({ ...handle, status: 'stopped' }));
        emitCommand(renderer, 'stop', clipName);
        callFirst(renderer, ['stopClip', 'stop'], clipName);
        resolveFinished(clipName);
        emitState(renderer, state);
      },
      pause: () => {
        updateHandle(clipName, (handle) => ({ ...handle, status: 'paused' }));
        emitCommand(renderer, 'pause', clipName);
        callFirst(renderer, ['pauseClip', 'pause'], clipName);
        emitState(renderer, state);
      },
      resume: () => {
        updateHandle(clipName, (handle) => ({ ...handle, status: 'playing' }));
        emitCommand(renderer, 'resume', clipName);
        callFirst(renderer, ['resumeClip', 'resume'], clipName);
        emitState(renderer, state);
      },
      setWeight: (weight: number) => {
        const nextWeight = Math.max(0, numberOr(weight, 1));
        updateHandle(clipName, (handle) => ({ ...handle, weight: nextWeight }));
        emitCommand(renderer, 'setWeight', clipName, { weight: nextWeight });
        callFirst(renderer, ['setClipWeight', 'setWeight'], clipName, nextWeight);
        emitState(renderer, state);
      },
      setPlaybackRate: (rate: number) => {
        const nextRate = Math.max(0, numberOr(rate, 1));
        updateHandle(clipName, (handle) => ({ ...handle, rate: nextRate }));
        emitCommand(renderer, 'setPlaybackRate', clipName, { rate: nextRate });
        callFirst(renderer, ['setClipPlaybackRate', 'setPlaybackRate'], clipName, nextRate);
        emitState(renderer, state);
      },
      setLoop: (mode: LoopMode, repeatCount?: number) => {
        const nextMode = LOOP_MODES.has(mode) ? mode : 'repeat';
        updateHandle(clipName, (handle) => ({
          ...handle,
          loopMode: nextMode,
          loop: nextMode !== 'once',
          repeatCount,
        }));
        emitCommand(renderer, 'setLoop', clipName, { loopMode: nextMode, repeatCount });
        callFirst(renderer, ['setClipLoop', 'setLoop'], clipName, nextMode, repeatCount);
        emitState(renderer, state);
      },
      setTime: (time: number) => {
        const duration = state.handles[clipName]?.duration ?? 0;
        const nextTime = clamp(0, duration, time);
        updateHandle(clipName, (handle) => ({ ...handle, time: nextTime }));
        emitCommand(renderer, 'setTime', clipName, { time: nextTime });
        callFirst(renderer, ['setClipTime', 'setTime'], clipName, nextTime);
        emitState(renderer, state);
      },
      getTime: () => {
        const rendererTime = callFirst(renderer, ['getClipTime', 'getTime'], clipName);
        return numberOr(rendererTime, state.handles[clipName]?.time ?? 0);
      },
      getDuration: () => {
        const rendererDuration = callFirst(renderer, ['getClipDuration', 'getDuration'], clipName);
        return numberOr(rendererDuration, state.handles[clipName]?.duration ?? 0);
      },
      subscribe: (listener: ClipEventListener) => {
        const clipListeners = listeners.get(clipName) ?? new Set<ClipEventListener>();
        clipListeners.add(listener);
        listeners.set(clipName, clipListeners);
        return () => {
          clipListeners.delete(listener);
        };
      },
      finished,
    };
  };

  const acceptClipEvent = (event: ClipEvent | Record<string, unknown>): boolean => {
    const eventRecord: Record<string, unknown> = isRecord(event)
      ? event as Record<string, unknown>
      : {};
    const clipName = keyToString(eventRecord.clipName ?? eventRecord.name);
    if (!clipName) return true;

    const eventType = keyToString(eventRecord.type ?? eventRecord.event);
    const currentTime = numberOr(
      eventRecord.currentTime,
      numberOr(eventRecord.time, state.handles[clipName]?.time ?? 0)
    );

    if (['time', 'progress', 'frame', 'keyframe', 'seek', 'loop'].includes(eventType)) {
      updateHandle(clipName, (handle) => ({ ...handle, time: currentTime }));
    } else if (eventType === 'paused') {
      updateHandle(clipName, (handle) => ({ ...handle, status: 'paused' }));
    } else if (['resumed', 'started', 'played'].includes(eventType)) {
      updateHandle(clipName, (handle) => ({ ...handle, status: 'playing' }));
    } else if (['completed', 'finished'].includes(eventType)) {
      updateHandle(clipName, (handle) => ({
        ...handle,
        status: 'completed',
        time: handle.duration,
      }));
      resolveFinished(clipName);
    } else if (['stopped', 'removed'].includes(eventType)) {
      updateHandle(clipName, (handle) => ({ ...handle, status: 'stopped' }));
      resolveFinished(clipName);
    }

    state.eventCount += 1;
    state.lastEvent = { ...eventRecord, timestamp: nowMs() };
    notifyListeners(clipName, event as ClipEvent);
    emitState(renderer, state);
    return true;
  };

  const buildClip = (
    clipNameInput: string,
    curvesInput: CurvesMap,
    optionsInput?: ClipOptions
  ): ClipHandle | null => {
    const clipName = keyToString(clipNameInput);
    if (!clipName) return null;

    const curves = normalizeCurves(curvesInput);
    const options = normalizeOptions(optionsInput);
    const connectorResult = callFirst(renderer, ['buildClip', 'playClip'], clipName, curves, options);
    if (connectorResult == null || connectorResult === false) {
      return null;
    }

    const result = isRecord(connectorResult) ? connectorResult : {};
    const duration = calculateDuration(curves, result.duration);
    const handleState: RuntimeHandleState = {
      clipName,
      actionId: keyToString(result.actionId ?? result.id) || makeActionId(clipName),
      duration,
      time: numberOr(result.time, options.startTime),
      weight: options.weight,
      rate: options.rate,
      loopMode: options.loopMode,
      loop: options.loop,
      repeatCount: options.repeatCount,
      reverse: options.reverse,
      source: options.source,
      status: 'playing',
      createdAt: nowMs(),
      updatedAt: nowMs(),
    };

    upsertHandle(handleState);
    emitCommand(renderer, 'buildClip', clipName, {
      actionId: handleState.actionId,
      duration: handleState.duration,
      options,
    });
    emitState(renderer, state);
    return makeHandle(clipName);
  };

  return {
    snapshot: () => snapshotState(state),
    buildClip,
    playSnippet: (clipName, curves, options) => (
      buildClip(clipName, curves, { ...options, source: options?.source ?? 'snippet' })
    ),
    acceptClipEvent,
    cleanupSnippet: (clipNameInput) => {
      const clipName = keyToString(clipNameInput);
      if (!clipName) return false;
      removeHandle(clipName);
      emitCommand(renderer, 'cleanupSnippet', clipName);
      callFirst(renderer, ['cleanupSnippet', 'removeClip'], clipName);
      emitState(renderer, state);
      return true;
    },
    updateClipParams: (clipNameInput, params) => {
      const clipName = keyToString(clipNameInput);
      if (!clipName) return false;
      const source = isRecord(params) ? params : {};

      updateHandle(clipName, (handle) => ({
        ...handle,
        weight: finiteNumber(source.weight) ? Math.max(0, source.weight) : handle.weight,
        rate: finiteNumber(source.rate) ? Math.max(0, source.rate) : handle.rate,
        loopMode: typeof source.loopMode === 'string' && LOOP_MODES.has(source.loopMode as LoopMode)
          ? source.loopMode as LoopMode
          : handle.loopMode,
        loop: typeof source.loop === 'boolean' ? source.loop : handle.loop,
        repeatCount: finiteNumber(source.repeatCount) ? source.repeatCount : handle.repeatCount,
        reverse: typeof source.reverse === 'boolean' ? source.reverse : handle.reverse,
      }));
      emitCommand(renderer, 'updateClipParams', clipName, { params: source });
      const result = callFirst(renderer, ['updateClipParams'], clipName, source);
      emitState(renderer, state);
      return result === false ? false : true;
    },
  };
}

export function installEmbody(
  target: Record<string, unknown> = globalThis as unknown as Record<string, unknown>
): { createAnimationRuntime: typeof createAnimationRuntime } {
  target.createAnimationRuntime = createAnimationRuntime;
  return { createAnimationRuntime };
}
