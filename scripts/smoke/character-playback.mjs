import assert from 'node:assert/strict';
import { AnimationClip, BufferGeometry, Float32BufferAttribute, Group, Mesh, MeshBasicMaterial, NumberKeyframeTrack, Timer } from 'three';
import { createRustEmbodyHost, renderScenePlayback } from '../../dist/three.js';

const model = new Group();
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
  const stalePause = handle.pause;
  const oldId = handle.actionId;
  handle.stop(); handle.play();
  assert.notEqual(handle.actionId, oldId);
  assert.throws(stalePause, /obsolete|released/);
  assert.equal(handle.finished, handle.promise);
  character.stopAllAnimations();

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
