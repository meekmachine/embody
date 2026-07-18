import { describe, expect, it } from 'vitest';
import { createAnimationRuntime } from './cljs';

describe('createAnimationRuntime', () => {
  it('owns clip handle state while routing renderer commands through the connector', async () => {
    const connectorCalls: unknown[][] = [];
    const commands: Array<Record<string, unknown>> = [];
    const runtime = createAnimationRuntime({ owner: 'test' }, {
      buildClip: (clipName, curves, options) => {
        connectorCalls.push(['buildClip', clipName, curves, options]);
        return { actionId: `${clipName}:action`, duration: 1 };
      },
      setClipWeight: (clipName, weight) => connectorCalls.push(['setClipWeight', clipName, weight]),
      setClipPlaybackRate: (clipName, rate) => connectorCalls.push(['setClipPlaybackRate', clipName, rate]),
      setClipLoop: (clipName, mode, repeatCount) => connectorCalls.push(['setClipLoop', clipName, mode, repeatCount]),
      setClipTime: (clipName, time) => connectorCalls.push(['setClipTime', clipName, time]),
      stopClip: (clipName) => connectorCalls.push(['stopClip', clipName]),
      onCommand: (command) => commands.push(command),
    });

    const handle = runtime.buildClip(
      'gaze/look',
      {
        43: [
          { time: 0, intensity: 0, inherit: true },
          { time: 1, intensity: 1 },
        ],
      },
      { loopMode: 'once', weight: 0.75, playbackRate: 1.5 }
    );

    expect(handle).toBeTruthy();
    if (!handle) throw new Error('Expected runtime.buildClip to return a handle');
    expect(handle.clipName).toBe('gaze/look');
    expect(handle.actionId).toBe('gaze/look:action');
    expect(handle.getDuration()).toBe(1);
    expect(commands.some((command) => command.op === 'buildClip')).toBe(true);

    const events: unknown[] = [];
    handle.subscribe?.((event) => events.push(event));
    handle.setWeight?.(0.4);
    handle.setPlaybackRate?.(2);
    handle.setLoop?.('repeat', 3);
    handle.setTime?.(0.5);

    runtime.acceptClipEvent({
      type: 'keyframe',
      clipName: 'gaze/look',
      keyframeIndex: 1,
      totalKeyframes: 2,
      currentTime: 0.5,
      duration: 1,
      iteration: 0,
    });
    runtime.acceptClipEvent({
      type: 'completed',
      clipName: 'gaze/look',
      currentTime: 1,
      duration: 1,
      iteration: 0,
    });

    await handle.finished;

    const snapshot = runtime.snapshot();
    expect(snapshot.handles).toMatchObject({
      'gaze/look': {
        status: 'completed',
        time: 1,
        weight: 0.4,
        rate: 2,
        loopMode: 'repeat',
      },
    });
    expect(events).toHaveLength(2);
    expect(connectorCalls).toEqual(expect.arrayContaining([
      ['setClipWeight', 'gaze/look', 0.4],
      ['setClipPlaybackRate', 'gaze/look', 2],
      ['setClipLoop', 'gaze/look', 'repeat', 3],
      ['setClipTime', 'gaze/look', 0.5],
    ]));
  });
});
