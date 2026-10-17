import assert from 'node:assert/strict';
import { AdditiveAnimationBlendMode, AnimationClip, BufferGeometry, Float32BufferAttribute, Group, Mesh, MeshBasicMaterial, NumberKeyframeTrack, Timer } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { createRustEmbodyHost, renderScenePlayback } from '../../dist/three.js';

const model = new Group();
// Load an actual single-key glTF cubic track, including its tangent storage.
const cubicSamples = new Float32Array([0, 0, 0, 0, 2, 3, 4, 0, 0, 0]);
const cubicJson = new TextEncoder().encode(JSON.stringify({
  asset: { version: '2.0' }, buffers: [{ byteLength: cubicSamples.byteLength }],
  bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 4 }, { buffer: 0, byteOffset: 4, byteLength: 36 }],
  accessors: [{ bufferView: 0, componentType: 5126, count: 1, type: 'SCALAR', min: [0], max: [0] }, { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' }],
  nodes: [{ name: 'CubicProp' }], scenes: [{ nodes: [0] }], scene: 0,
  animations: [{ name: 'single-cubic', samplers: [{ input: 0, output: 1, interpolation: 'CUBICSPLINE' }], channels: [{ sampler: 0, target: { node: 0, path: 'scale' } }] }],
}));
const jsonChunkLength = Math.ceil(cubicJson.length / 4) * 4;
const cubicGlb = new ArrayBuffer(28 + jsonChunkLength + cubicSamples.byteLength);
const cubicHeader = new DataView(cubicGlb);
for (const [offset, value] of [[0, 0x46546c67], [4, 2], [8, cubicGlb.byteLength], [12, jsonChunkLength], [16, 0x4e4f534a], [20 + jsonChunkLength, cubicSamples.byteLength], [24 + jsonChunkLength, 0x004e4942]]) cubicHeader.setUint32(offset, value, true);
const cubicBytes = new Uint8Array(cubicGlb);
cubicBytes.fill(32, 20, 20 + jsonChunkLength);
cubicBytes.set(cubicJson, 20);
cubicBytes.set(new Uint8Array(cubicSamples.buffer), 28 + jsonChunkLength);
const cubicAsset = await new GLTFLoader().parseAsync(cubicGlb, '');
model.add(cubicAsset.scene);
const geometry = new BufferGeometry();
geometry.setAttribute('position', new Float32BufferAttribute([0, 0, 0], 3));
const face = new Mesh(geometry, new MeshBasicMaterial());
face.name = 'Face';
face.morphTargetDictionary = { Smile: 0 };
face.morphTargetInfluences = [0];
model.add(face);
const profile = { auToMorphs: { 200: { center: ['Smile'], left: [], right: [] } }, morphToMesh: { face: ['Face'] } };
const character = await createRustEmbodyHost(model, { profileMode: 'profile', profile });
const timer = new Timer();
timer.update(0);
let timestamp = 0;
const step = (seconds) => { timestamp += seconds * 1000; timer.update(timestamp); renderScenePlayback(model, timer); };
const near = (actual, expected) => assert(Math.abs(actual - expected) < 1e-5, `${actual} != ${expected}`);
const value = () => face.morphTargetInfluences[0];
const snippet = (name, end) => ({ name, curves: { 200: [{ time: 0, intensity: 0, inherit: true }, { time: 1, intensity: end }] } });

try {
  assert.equal('update' in character, false, 'hosts cannot advance an Embody clock');
  const move = new AnimationClip('move', 2, [new NumberKeyframeTrack('Face.morphTargetInfluences[0]', [0, 2], [0, 1])]);
  character.registerAnimationClips([move]);
  const handle = character.playAnimation('move', { loopMode: 'repeat' });
  step(0.5); near(value(), 0.25);
  handle.pause(); step(0.5); near(value(), 0.25);
  handle.seek(1.5); step(0); near(value(), 0.75);
  handle.setIntensity(0.5); step(0); near(value(), 0.375);
  near(character.getAnimationState('move').mixerWeight, 1);
  handle.updateParams({ loop: false });
  assert.equal(character.getAnimationState('move').loopMode, 'once');
  handle.updateParams({ loop: true });
  assert.equal(character.getAnimationState('move').loopMode, 'repeat');
  const stalePause = handle.pause;
  const oldId = handle.actionId;
  handle.stop(); handle.play();
  assert.notEqual(handle.actionId, oldId);
  assert.throws(stalePause, /obsolete|released/);
  assert.equal(handle.finished, handle.promise);
  character.stopAllAnimations();

  const cubicClip = cubicAsset.animations[0];
  const originalCubicValues = Array.from(cubicClip.tracks[0].values);
  character.registerAnimationClips([cubicClip]);
  const cubicHandle = character.playAnimation(cubicClip.name, { blendMode: 'additive', intensityScale: 0.5 });
  step(0);
  const cubicProp = cubicAsset.scene.getObjectByName('CubicProp');
  cubicProp.scale.toArray().forEach((value, axis) => near(value, [1.5, 2, 2.5][axis]));
  cubicHandle.stop();
  const additiveCubic = cubicClip.clone();
  additiveCubic.name = 'single-cubic-additive';
  additiveCubic.blendMode = AdditiveAnimationBlendMode;
  character.registerAnimationClips([additiveCubic]);
  character.playAnimation(additiveCubic.name, { blendMode: 'replace' });
  step(0);
  cubicProp.scale.toArray().forEach((value, axis) => near(value, [3, 4, 5][axis]));
  assert.deepEqual(Array.from(cubicClip.tracks[0].values), originalCubicValues);
  character.stopAllAnimations();

  const prepared = character.buildClip('prepared', { 200: [{ time: 0, intensity: 0 }, { time: 1, intensity: 1 }] }, { loopMode: 'repeat', intensityScale: 1, time: 0.1, clampWhenFinished: false });
  prepared.stop();
  prepared.updateParams({ weight: 0.5, loop: false, offsetSec: 0.5, finalPose: 'hold' });
  assert.equal(character.getAnimationState('prepared').playing, false);
  prepared.play();
  assert.equal(character.getAnimationState('prepared').loopMode, 'once');
  step(0); near(value(), 0.25);
  prepared.updateParams({ offsetSec: 0.6 });
  prepared.play();
  step(0); near(value(), 0.3);
  step(0.5); near(value(), 0.5);
  assert.equal(character.getAnimationState('prepared').completed, true);
  prepared.updateParams({ clampWhenFinished: false });
  step(0); near(value(), 0);
  prepared.play();
  prepared.updateParams({ finalPose: 'hold' });
  step(0.5); near(value(), 0.5);
  prepared.stop();

  character.setAU(200, 0.8);
  step(0.001); near(value(), 0.8);
  const release = character.transitionAU(200, 0, 1000);
  step(0.5); near(value(), 0.4);
  step(0.5); near(value(), 0);
  await release.promise;

  face.morphTargetInfluences[0] = 0.2;
  const inherited = character.playSnippet(snippet('inherited', 0.8), { loopMode: 'once' });
  inherited.pause(); inherited.seek(0.5); step(0); near(value(), 0.5);
  inherited.setIntensity(0.5); step(0); near(value(), 0.3);
  inherited.stop();
  face.morphTargetInfluences[0] = 0;

  const base = new AnimationClip('base', 1, [new NumberKeyframeTrack('Face.morphTargetInfluences[0]', [0, 1], [0.2, 0.2])]);
  character.registerAnimationClips([base]);
  character.playAnimation('base', { loopMode: 'repeat' });
  step(0);
  const first = character.playSnippet(snippet('layer', 0.4), { blendMode: 'additive', loopMode: 'once' });
  step(0.5); near(value(), 0.4);
  const replacement = character.playSnippet(snippet('layer', 0.6), { blendMode: 'additive', loopMode: 'once' });
  step(0); near(value(), 0.4);
  first.stop();
  step(0.5); near(value(), 0.6);
  replacement.stop();
  character.stopAllAnimations();

  character.playAnimation('move', { loopMode: 'repeat' });
  step(0.25);
  const nativeTime = character.getAnimationState('move').time;
  character.stop(); step(10); near(character.getAnimationState('move').time, nativeTime);
  character.start(); step(0.25); near(character.getAnimationState('move').time, nativeTime + 0.25);
  character.stopAllAnimations();

  character.setAU(200, 0.8); step(0.001); near(value(), 0.8);
  character.setProfile({ ...profile, morphToMesh: { face: [] } });
  step(0); near(value(), 0);
  character.setAU(200, 1); step(0.001); near(value(), 0);
  const empty = character.playSnippet(snippet('unmapped', 1), { loopMode: 'once', finalPose: 'release' });
  step(1);
  assert.equal((await empty.promise).type, 'completed', 'unmapped authored clips retain native lifecycle');
  empty.stop();
} finally {
  character.dispose();
  character.dispose();
  timer.dispose();
  geometry.dispose();
  face.material.dispose();
}
