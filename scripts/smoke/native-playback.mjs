import assert from 'node:assert/strict';
import { AnimationClip, AnimationMixer, Group, Object3D, Timer, VectorKeyframeTrack } from 'three';
import { initEmbodyCore } from '../../dist/wasm.js';
import { renderScenePlayback, ThreeModelInspector, ThreeNativePlaybackConnector } from '../../dist/three.js';

const wasm = await initEmbodyCore();
const model = new Group();
const target = new Object3D();
target.name = 'Target';
model.add(target);
const mixer = new AnimationMixer(model);
const inspection = new ThreeModelInspector().inspectModel(model);
const connector = new ThreeNativePlaybackConnector(new wasm.NativePlaybackSession(), { model, inspection, mixer });
connector.rebind(model.uuid, 'profile');
const timer = new Timer();
timer.update(0);
let timestamp = 0;
const step = (seconds) => { timestamp += seconds * 1000; timer.update(timestamp); renderScenePlayback(model, timer); };
const close = (a, b) => assert(Math.abs(a - b) < 1e-5, `${a} != ${b}`);
const events = [];
connector.subscribe((event) => events.push(event));
const clip = new AnimationClip('move', 1, [
  new VectorKeyframeTrack('Target.position', [0, 0.5, 0.5, 1], [0, 0, 0, 0.5, 0, 0, 0.5, 0, 0, 1, 0, 0]),
]);

try {
  const first = connector.playNativeClip(clip, { finalPose: 'hold' });
  step(0.25); close(target.position.x, 0.25);
  connector.control(first, { type: 'pause' });
  step(1); close(target.position.x, 0.25);
  connector.control(first, { type: 'seek', seconds: 0.5 });
  step(0); close(target.position.x, 0.5);
  connector.control(first, { type: 'setSpeed', speed: 2 });
  connector.control(first, { type: 'resume' });
  connector.setRendering(false);
  step(10); close(target.position.x, 0.5);
  assert.equal(events.length, 0, 'a suspended render host cannot finish an animation');
  connector.setRendering(true);
  step(0.25); close(target.position.x, 1);
  assert.deepEqual(events.map((event) => event.type), ['completed']);
  const edited = clip.clone();
  for (let i = 0; i < edited.tracks[0].values.length; i += 3) edited.tracks[0].values[i] *= 0.5;
  const heldAction = connector.getAction(first);
  connector.replaceClip(first, edited);
  step(0); close(target.position.x, 0.5);
  assert.equal(connector.getAction(first), heldAction, 'editing strength retains native action and loop progress');
  connector.replaceClip(first, new AnimationClip('resampled', 1, [new VectorKeyframeTrack('Target.position', [0, 1], [0, 0, 0, 0.75, 0, 0])]));
  step(0); close(target.position.x, 0.75);
  assert.equal(connector.getAction(first), heldAction, 'resampling an authored easing curve retains native playback identity');
  connector.control(first, { type: 'stop' });
  assert.equal(events.length, 1, 'releasing a held pose does not settle it twice');

  // Two requests may deliberately share the same clip and target. Each owns a
  // distinct native action and participates in native weight normalization.
  const left = connector.playNativeClip(clip, { weight: 0.5, loop: { mode: 'repeat' } });
  const right = connector.playNativeClip(clip, { weight: 0.5, startSeconds: 0.5, loop: { mode: 'repeat' } });
  assert.notEqual(connector.getAction(left), connector.getAction(right));
  step(0); close(target.position.x, 0.25);
  const replacement = connector.playNativeClip(clip, { replace: left, loop: { mode: 'repeat', count: 2 } });
  assert.throws(() => connector.control(left, { type: 'stop' }), /stale/);
  assert(connector.getAction(right));
  connector.control(right, { type: 'stop' });
  step(1); assert(connector.getAction(replacement));
  step(1); assert.equal(connector.getAction(replacement), undefined);
  assert.equal(events.filter((event) => event.handle === replacement && event.type === 'completed').length, 1);

  const fading = connector.playNativeClip(clip, { loop: { mode: 'repeat' } });
  connector.fadeOut(fading, 0.25);
  step(0.125); assert(connector.getAction(fading));
  step(0.125); assert.equal(connector.getAction(fading), undefined);
  const rebound = connector.playNativeClip(clip);
  connector.rebind(model.uuid, 'next-profile');
  assert.equal(connector.getAction(rebound), undefined);
  assert.throws(() => connector.control(rebound, { type: 'seek', seconds: 0.5 }), /stale/);
  const zero = clip.clone(); zero.duration = 0;
  const immediate = connector.playNativeClip(zero, { finalPose: 'hold' });
  step(0.001);
  assert.equal(events.filter((event) => event.handle === immediate).length, 1);
  connector.control(immediate, { type: 'stop' });
  const empty = connector.playNativeClip(new AnimationClip('unmapped', 0.5, []));
  step(0.25);
  assert.equal(events.filter((event) => event.handle === empty).length, 0);
  step(0.25);
  assert.deepEqual(events.filter((event) => event.handle === empty).map((event) => event.type), ['completed']);
} finally {
  connector.dispose();
  connector.dispose();
  timer.dispose();
}
assert.equal(mixer.stats.actions.inUse, 0);
assert.equal(mixer.stats.actions.total, 0, 'replacement and disposal release owned native actions');
