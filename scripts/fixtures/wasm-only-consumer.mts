// CI compiles this packed-package consumer outside the repository, without Three.
import {
  initEmbodyCore,
  type ClipIR,
  type ClipIRChannel,
  type ClipIRTarget,
  type ClipIRTrack,
} from '@lovelace_lol/embody/wasm';

const channel: ClipIRChannel = { id: 3, kind: 'scene', name: 'Camera-independent prop' };
const target: ClipIRTarget = { kind: 'objectTransform', objectId: 7, property: 'position' };
const track: ClipIRTrack = {
  id: 9, channelId: channel.id, target, valueType: 'vec3',
  times: [0, 0.5], values: [0, 0, 0, 1, 2, 3],
  interpolation: 'linear', inheritStart: true, sourceName: 'saved-position',
};
const clip: ClipIR = {
  id: 'saved-clip', name: 'move', durationSeconds: 0.5,
  channels: [channel], tracks: [track], metadata: { author: 'connector-consumer' },
};
const duration: number | undefined = clip.durationSeconds;
const channelName: string | undefined = clip.channels?.[0].name;
const values: number[] = clip.tracks[0].values;
const core = await initEmbodyCore();
const serialized: string = core.compile_clip(JSON.stringify({
  ...clip,
  tracks: [{
    ...track,
    keyframes: [{ time: 0, value: [0, 0, 0], inherit: true }, { time: 0.5, value: [1, 2, 3] }],
  }],
}));
// @ts-expect-error The neutral declarations retain numeric keyframe values.
const invalidValues: ClipIRTrack = { ...track, values: ['not-a-number'] };
// @ts-expect-error Channel identifiers are model-independent numeric IDs.
const invalidChannel: ClipIRChannel = { id: 'scene', kind: 'scene' };
// @ts-expect-error Core declarations remain generated, not an untyped connector bag.
core.missing_playback_engine();
void [duration, channelName, values, serialized, invalidValues, invalidChannel];
