import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { initEmbodyCore } from '@lovelace_lol/embody/wasm';

// This consumer contains the packed Embody package and no renderer dependency.
const require = createRequire(import.meta.url);
assert.throws(() => require.resolve('three'), { code: 'MODULE_NOT_FOUND' });
const core = await initEmbodyCore();
const target = { kind: 'objectTransform', objectId: 7, property: 'position' };
const clip = JSON.parse(core.compile_clip(JSON.stringify({
  id: 'saved-clip', name: 'move', durationSeconds: 0.5,
  channels: [{ id: 3, kind: 'scene', name: 'Prop' }],
  metadata: { author: 'connector-consumer' },
  tracks: [{
    id: 9, channelId: 3, target, valueType: 'vec3',
    interpolation: 'linear', sourceName: 'saved-position',
    keyframes: [{ time: 0, value: [0, 0, 0], inherit: true }, { time: 0.5, value: [1, 2, 3] }],
  }],
})));
assert.equal(clip.id, 'saved-clip');
assert.equal(clip.durationSeconds, 0.5);
assert.deepEqual(clip.channels, [{ id: 3, kind: 'scene', name: 'Prop' }]);
assert.deepEqual(clip.metadata, { author: 'connector-consumer' });
assert.deepEqual(clip.tracks[0], {
  id: 9, channelId: 3, target, valueType: 'vec3', times: [0, 0.5],
  values: [0, 0, 0, 1, 2, 3], interpolation: 'linear',
  inheritStart: true, sourceName: 'saved-position',
});
