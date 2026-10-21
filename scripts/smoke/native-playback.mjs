import assert from 'node:assert/strict';
import { AnimationClip, AnimationMixer, Bone, BufferGeometry, Group, Mesh, MeshBasicMaterial, NumberKeyframeTrack, Object3D, QuaternionKeyframeTrack, VectorKeyframeTrack } from 'three';
import { initEmbodyCore } from '../../dist/wasm.js';
import { renderScenePlayback, ThreeModelInspector, ThreeNativePlaybackConnector } from '../../dist/three.js';
import { createPlaybackTimer } from '../test/helpers/render-playback.mjs';

const wasm = await initEmbodyCore();
const model = new Group();
const target = new Object3D();
target.name = 'Target';
const face = new Mesh(new BufferGeometry(), new MeshBasicMaterial());
face.name = 'Face';
face.morphTargetDictionary = { Smile: 0 };
face.morphTargetInfluences = [0];
const head = new Bone();
head.name = 'Head';
model.add(target, face, head);
const mixer = new AnimationMixer(model);
const inspection = new ThreeModelInspector().inspectModel(model);
const releases = [];
const connector = new ThreeNativePlaybackConnector(new wasm.NativePlaybackSession(), { model, inspection, mixer, onRelease: (handle) => releases.push(handle) });
connector.rebind(model.uuid, 'profile');
const timer = createPlaybackTimer();
let timestamp = 0;
const step = (seconds) => { timestamp += seconds * 1000; timer.update(timestamp); renderScenePlayback(model, timer); };
const close = (a, b) => assert(Math.abs(a - b) < 1e-5, `${a} != ${b}`);
const events = [];
connector.subscribe((event) => events.push(event));
const clip = new AnimationClip('move', 1, [
  new VectorKeyframeTrack('Target.position', [0, 0.5, 0.5, 1], [0, 0, 0, 0.5, 0, 0, 0.5, 0, 0, 1, 0, 0]),
]);

try {
  // Source keys outside the interval must still determine fractional boundaries.
  const travel = connector.playNativeClip(clip, { startSeconds: 0.2, endSeconds: 0.7, speed: 2, finalPose: 'hold' });
  step(0.1); close(target.position.x, 0.4);
  step(1); close(target.position.x, 0.7);
  close(connector.getSourceTime(travel), 0.7);
  assert.equal(events.filter((e) => e.handle === travel && e.type === 'completed').length, 1);
  const backward = connector.playNativeClip(clip, { replace: travel, startSeconds: 0.7, endSeconds: 0.3, speed: -1, finalPose: 'hold' });
  step(0.2); close(target.position.x, 0.5);
  connector.control(backward, { type: 'pause' });
  step(2); close(target.position.x, 0.5);
  connector.control(backward, { type: 'resume' });
  step(2); close(target.position.x, 0.3);
  connector.control(backward, { type: 'stop' });
  events.length = 0; releases.length = 0;
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
  assert.deepEqual(releases, [first], 'held resource release retires owner bookkeeping without another terminal event');

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
  connector.control(fading, { type: 'pause' });
  const pausedFadeWeight = connector.getAction(fading).getEffectiveWeight();
  step(1); close(connector.getAction(fading).getEffectiveWeight(), pausedFadeWeight);
  connector.control(fading, { type: 'resume' });
  step(0.0625); close(connector.getAction(fading).getEffectiveWeight(), pausedFadeWeight / 2);
  step(0.0625); assert.equal(connector.getAction(fading), undefined);

  const heldFade = connector.playNativeClip(clip, { finalPose: 'hold' });
  step(1);
  assert.equal(connector.getAction(heldFade).paused, true, 'native completion clamps the held action');
  connector.fadeOut(heldFade, 0.5);
  step(0.125); close(connector.getAction(heldFade).getEffectiveWeight(), 0.75);
  connector.setRendering(false);
  step(2); close(connector.getAction(heldFade).getEffectiveWeight(), 0.75);
  connector.setRendering(true);
  step(0.125); close(connector.getAction(heldFade).getEffectiveWeight(), 0.5);
  step(0.25); assert.equal(connector.getAction(heldFade), undefined, 'completed holds still fade and release after render suspension');
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

  const concreteClip = (name, destination, valueType, value) => ({
    name, durationSeconds: 1, channels: [{ id: 1, kind: 'face' }],
    tracks: [{ id: 1, channelId: 1, target: destination, valueType, times: [0, 1], values: [...value, ...value] }],
  });
  const [morphId, morphBinding] = [...inspection.morphBindings].find(([, binding]) => binding.mesh === face && binding.index === 0);
  const meshId = [...inspection.meshBindings].find(([, mesh]) => mesh === face)[0];
  const namedMorph = new AnimationClip('named-morph', 1, [
    new NumberKeyframeTrack('Face.morphTargetInfluences[Smile]', [0, 1], [0, 0.4]),
  ]);
  const numericMorph = new AnimationClip('numeric-morph', 1, [
    new NumberKeyframeTrack('Face.morphTargetInfluences[0]', [0, 1], [0.8, 0.8]),
  ]);
  const namedMorphHandle = connector.playNativeClip(namedMorph, { startSeconds: 0.5, loop: { mode: 'repeat' } });
  const numericMorphHandle = connector.playNativeClip(numericMorph, { loop: { mode: 'repeat' } });
  step(0); close(face.morphTargetInfluences[0], 0.5);
  const compiledMorph = connector.play(concreteClip('compiled-morph', { kind: 'morphTarget', meshId, morphTargetId: morphId }, 'scalar', [1]), { loop: { mode: 'repeat' } });
  step(0); close(face.morphTargetInfluences[0], 2 / 3);
  const namedAction = connector.getAction(namedMorphHandle);
  assert.equal(namedAction.getClip().tracks[0].name, `${morphBinding.mesh.uuid}.morphTargetInfluences[0]`);
  assert.equal(namedMorph.tracks[0].name, 'Face.morphTargetInfluences[Smile]', 'normalization never mutates the source name');
  const editedMorph = numericMorph.clone();
  editedMorph.tracks[0].values.set([0, 0.8]);
  connector.replaceClip(namedMorphHandle, editedMorph);
  assert.equal(connector.getAction(namedMorphHandle), namedAction, 'a numeric alias edits the existing named action');
  close(namedAction.time, 0.5);
  step(0); close(face.morphTargetInfluences[0], 2.2 / 3);
  assert.deepEqual(Array.from(namedMorph.tracks[0].values), Array.from(new Float32Array([0, 0.4])));
  assert.equal(editedMorph.tracks[0].name, 'Face.morphTargetInfluences[0]');
  for (const handle of [namedMorphHandle, numericMorphHandle, compiledMorph]) connector.control(handle, { type: 'stop' });

  const objectId = [...inspection.objectBindings].find(([, object]) => object === target)[0];
  const boneId = [...inspection.boneBindings].find(([, bone]) => bone === head)[0];
  const nativeTransforms = new AnimationClip('named-transforms', 1, [
    new VectorKeyframeTrack('Target.position', [0, 1], [2, 0, 0, 2, 0, 0]),
    new QuaternionKeyframeTrack('Head.quaternion', [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]),
  ]);
  const transforms = connector.playNativeClip(nativeTransforms, { loop: { mode: 'repeat' } });
  const position = connector.play(concreteClip('compiled-position', { kind: 'objectTransform', objectId, property: 'position' }, 'vec3', [8, 0, 0]), { loop: { mode: 'repeat' } });
  const rotation = connector.play(concreteClip('compiled-rotation', { kind: 'boneTransform', boneId, property: 'rotation' }, 'quat', [0, 0, Math.SQRT1_2, Math.SQRT1_2]), { loop: { mode: 'repeat' } });
  step(0); close(target.position.x, 5); close(head.quaternion.z, Math.sin(Math.PI / 8));
  assert.deepEqual(nativeTransforms.tracks.map((track) => track.name), ['Target.position', 'Head.quaternion']);
  for (const handle of [transforms, position, rotation]) connector.control(handle, { type: 'stop' });
} finally {
  connector.dispose();
  connector.dispose();
  timer.dispose();
  face.geometry.dispose();
  face.material.dispose();
}
assert.equal(mixer.stats.actions.inUse, 0);
assert.equal(mixer.stats.actions.total, 0, 'replacement and disposal release owned native actions');
