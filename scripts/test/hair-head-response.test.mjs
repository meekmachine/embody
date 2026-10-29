import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import {
  AnimationClip, Bone, BufferGeometry, Group, Mesh, MeshBasicMaterial,
  Quaternion, QuaternionKeyframeTrack, Vector3,
} from 'three';
import { createRustEmbodyHostUnbound } from '@lovelace_lol/embody/three';
import { initEmbodyCore } from '@lovelace_lol/embody/wasm';
import { renderHostFrame } from './helpers/render-playback.mjs';

await initEmbodyCore();

// Hair responds to the head's rendered pose once per render step (Embody #172).
// Clip admission must not compile, play or retarget any hair action.
const HAIR_IDLE = '__embody_hair_idle';
const HAIR_RESPONSE = '__embody_hair_head_response';
const HAIR_IMPULSE = '__embody_hair_impulse';
const FRAME = 1 / 60;

const hairPhysics = {
  enabled: true, inertia: 2, gravity: 4, responseScale: 3, stiffness: 7.5, damping: 0.18,
  idleSwayAmount: 0, windStrength: 0, direction: { yawSign: 1, pitchSign: 1 },
  morphTargets: {
    swayLeft: { key: 'Sway_L', axis: 'yaw' }, swayRight: { key: 'Sway_R', axis: 'yaw' },
    headDown: { Down: { value: 1, axis: 'pitch' } },
  },
};
const profile = (hair = {}) => ({
  boneNodes: { HEAD: 'Head' },
  humanoidCharacterization: { schemaVersion: 1, standard: 'VRMC_vrm-1.0', status: 'characterized', roles: { head: { nodeKey: 'HEAD' } } },
  auToMorphs: { 200: { center: ['Smile'], left: [], right: [] } },
  morphToMesh: { face: ['Face'] },
  meshes: { Hair: { category: 'hair' } },
  hairPhysics: { ...hairPhysics, ...hair },
});

function mesh(name, morphs) {
  const result = new Mesh(new BufferGeometry(), new MeshBasicMaterial());
  result.name = name;
  result.morphTargetDictionary = Object.fromEntries(morphs.map((key, index) => [key, index]));
  result.morphTargetInfluences = morphs.map(() => 0);
  return result;
}
function fixture(t, hair) {
  const root = new Group();
  const face = mesh('Face', ['Smile']);
  const hairMesh = mesh('Hair', ['Sway_L', 'Sway_R', 'Down']);
  const neck = new Bone(); neck.name = 'Neck'; neck.position.y = 1.5;
  const head = new Bone(); head.name = 'Head'; head.position.y = 0.2;
  neck.add(head); root.add(face, hairMesh, neck);
  const host = createRustEmbodyHostUnbound({ profileMode: 'profile', profile: profile(hair) });
  t.after(() => {
    host.dispose();
    root.traverse((object) => { if (object.isMesh) { object.geometry.dispose(); object.material.dispose(); } });
  });
  host.onReady({ model: root });
  const influence = (key) => hairMesh.morphTargetInfluences[hairMesh.morphTargetDictionary[key]];
  return { root, head, neck, host, influence, sway: () => Math.max(influence('Sway_L'), influence('Sway_R')) };
}
// Count Rust hair work on the host's current core. The core is replaced on rebind.
function spyHairWork(host) {
  const core = host.core;
  const calls = { step: 0, build: 0 };
  const step = core.step_hair_head_response.bind(core);
  const build = core.build_hair_head_response_clip.bind(core);
  core.step_hair_head_response = (...args) => { calls.step += 1; return step(...args); };
  core.build_hair_head_response_clip = (...args) => { calls.build += 1; return build(...args); };
  return calls;
}
const yaw = (radians) => new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), radians).toArray();
const headTurn = (name, from, to, duration = 0.3) => new AnimationClip(name, duration, [
  new QuaternionKeyframeTrack('Head.quaternion', [0, duration], [...yaw(from), ...yaw(to)]),
]);
const actionId = (host, name) => host.getAnimationState(name).actionId;
const assertBounded = (fixtureState, message) => {
  for (const key of ['Sway_L', 'Sway_R', 'Down']) {
    const value = fixtureState.influence(key);
    assert.ok(Number.isFinite(value) && value >= 0 && value <= 2, `${message}: ${key}=${value}`);
  }
};

test('enabled hair with a profile head role plays one held response action and no impulse', (t) => {
  const { host } = fixture(t);
  const state = host.getAnimationState(HAIR_RESPONSE);
  assert.ok(state.actionId, 'the response action is bound with the model');
  assert.equal(state.blendMode, 'additive');
  assert.equal(actionId(host, HAIR_IMPULSE), undefined);
});

test('playing and retargeting clips performs no hair work', (t) => {
  const { host } = fixture(t);
  const calls = spyHairWork(host);
  const response = actionId(host, HAIR_RESPONSE);
  host.registerAnimationClips([headTurn('look', 0, 0.6)]);
  // EyeHead-style retargets of one slot, faster than the render step.
  for (let index = 0; index < 30; index += 1) {
    host.playAnimation('look', { blendMode: index % 2 ? 'additive' : undefined });
    host.playSnippet('gesture', { 200: [{ time: 0, intensity: 0 }, { time: 0.2, intensity: index / 30 }] });
  }
  assert.deepEqual(calls, { step: 0, build: 0 }, 'admission never reaches the hair response');
  assert.equal(actionId(host, HAIR_RESPONSE), response, 'the response action is not replaced');
  assert.equal(actionId(host, HAIR_IMPULSE), undefined, 'admission plays no hair impulse');
  assert.equal(host.getAnimationState('__embody_hair_gravity').actionId, undefined, 'admission plays no gravity clip');
});

test('baked head motion produces a bounded response, observed once per render step, that settles', (t) => {
  const fixtureState = fixture(t);
  const { host, sway } = fixtureState;
  const calls = spyHairWork(host);
  host.registerAnimationClips([headTurn('look', 0, 0.6)]);
  host.playAnimation('look', { finalPose: 'hold' });
  let peak = 0;
  for (let frame = 1; frame <= 30; frame += 1) {
    renderHostFrame(host, FRAME);
    assert.equal(calls.step, frame, 'exactly one hair observation per render step');
    assertBounded(fixtureState, `frame ${frame}`);
    peak = Math.max(peak, sway());
  }
  assert.ok(peak > 0.05, `the turn moves the hair (peak ${peak})`);
  for (let frame = 0; frame < 300; frame += 1) renderHostFrame(host, 0.05);
  assert.ok(sway() < 1e-3, `the held head lets the hair settle (${sway()})`);
});

test('direct head bone writes from any source drive the same response', (t) => {
  const fixtureState = fixture(t);
  const { host, head, sway } = fixtureState;
  renderHostFrame(host, FRAME);
  let peak = 0;
  for (let frame = 0; frame < 12; frame += 1) {
    head.rotation.y += 0.05; // e.g. a host tracking writer outside the mixer
    renderHostFrame(host, FRAME);
    assertBounded(fixtureState, `frame ${frame}`);
    peak = Math.max(peak, sway());
  }
  assert.ok(peak > 0.05, `observed bone motion moves the hair (peak ${peak})`);
});

test('parent bone motion reaches the head response through the model-space head rotation', (t) => {
  const { host, neck, sway } = fixture(t);
  renderHostFrame(host, FRAME);
  let peak = 0;
  for (let frame = 0; frame < 12; frame += 1) {
    neck.rotation.y -= 0.05;
    renderHostFrame(host, FRAME);
    peak = Math.max(peak, sway());
  }
  assert.ok(peak > 0.05, `neck motion moves the hair (peak ${peak})`);
});

test('head pitch drives configured gravity targets from the rendered pose', (t) => {
  const { host, head, influence } = fixture(t);
  head.rotation.x = 0.5;
  for (let frame = 0; frame < 3; frame += 1) renderHostFrame(host, FRAME);
  assert.ok(Math.abs(influence('Down') - 0.5) < 1e-3, `headDown weight follows pitch (${influence('Down')})`);
});

test('rapid retargets to a held pose never produce repeated impulses', (t) => {
  const fixtureState = fixture(t);
  const { host, sway } = fixtureState;
  host.registerAnimationClips([headTurn('hold', 0.4, 0.4, 1)]);
  host.playAnimation('hold', { finalPose: 'hold' });
  for (let frame = 0; frame < 400; frame += 1) renderHostFrame(host, 0.05);
  const response = actionId(host, HAIR_RESPONSE);
  for (let frame = 0; frame < 60; frame += 1) {
    host.playAnimation('hold', { finalPose: 'hold' });
    host.playAnimation('hold', { finalPose: 'hold' });
    renderHostFrame(host, FRAME);
    assert.ok(sway() < 1e-3, `frame ${frame}: an unchanged head pose leaves the hair at rest (${sway()})`);
  }
  assert.equal(actionId(host, HAIR_IMPULSE), undefined);
  assert.equal(actionId(host, HAIR_RESPONSE), response);
});

test('Stop All, crossfade and pause/resume all leave hair actions running', (t) => {
  const idleDuration = 0.5;
  const { host } = fixture(t, { idleSwayAmount: 0.3, idleClipDuration: idleDuration });
  const idle = actionId(host, HAIR_IDLE);
  const response = actionId(host, HAIR_RESPONSE);
  assert.ok(idle && response);
  host.registerAnimationClips([headTurn('a', 0, 0.3), headTurn('b', 0.3, 0)]);
  host.playAnimation('a', { loop: true });
  renderHostFrame(host, 0.1);
  host.stopAllAnimations();
  assert.equal(host.getAnimationState('a').playing, false, 'Stop All stops caller playback');
  assert.equal(actionId(host, HAIR_IDLE), idle);
  assert.equal(host.getAnimationState(HAIR_IDLE).playing, true, 'Stop All leaves hair idle running');
  assert.equal(actionId(host, HAIR_RESPONSE), response);
  host.playAnimation('a', { loop: true });
  host.crossfadeTo('b', 0.2, { loop: true });
  renderHostFrame(host, 0.3);
  assert.equal(host.getAnimationState(HAIR_IDLE).playing, true, 'crossfade leaves hair idle running');
  near(host.getAnimationState(HAIR_IDLE).mixerWeight, 1, 'crossfade does not fade hair idle');
  host.pauseAllAnimations(); host.resumeAllAnimations();
  assert.equal(actionId(host, HAIR_IDLE), idle);
  assert.equal(actionId(host, HAIR_RESPONSE), response, 'resume all does not replay the held response');
  const before = host.getAnimationState(HAIR_IDLE).time;
  renderHostFrame(host, 0.1);
  // The native action wraps at 0.5 s; local time need not increase across a loop.
  const after = host.getAnimationState(HAIR_IDLE).time;
  near((after - before + idleDuration) % idleDuration, 0.1, 'hair idle advances through its loop boundary');
  assert.equal(host.getAnimationState(HAIR_IDLE).playing, true);
});

test('stopped rendering, disabled hair, rebind and disposal gate the render-step response', (t) => {
  const { host, root, head } = fixture(t);
  let calls = spyHairWork(host);
  host.stop();
  head.rotation.y = 0.4;
  renderHostFrame(host, FRAME);
  assert.equal(calls.step, 0, 'no hair work while rendering is stopped');
  host.start();
  renderHostFrame(host, FRAME);
  assert.equal(calls.step, 1);
  host.setHairPhysicsEnabled(false);
  assert.equal(actionId(host, HAIR_RESPONSE), undefined, 'disabling hair releases the response action');
  renderHostFrame(host, FRAME);
  assert.equal(calls.step, 1, 'disabled hair performs no hair work');
  host.setHairPhysicsEnabled(true);
  const enabled = actionId(host, HAIR_RESPONSE);
  assert.ok(enabled, 'enabling hair restores the response action');
  host.bindModel();
  calls = spyHairWork(host);
  assert.notEqual(actionId(host, HAIR_RESPONSE), undefined, 'rebinding restores the response on the new binding');
  renderHostFrame(host, FRAME);
  assert.equal(calls.step, 1, 'the new binding observes once per render step');
  host.dispose();
  assert.doesNotThrow(() => renderHostFrame({ model: root }, FRAME), 'a disposed host leaves no render-step hook');
});

test('a profile without a head role plays no response and observes nothing', (t) => {
  const root = new Group();
  const hairMesh = mesh('Hair', ['Sway_L', 'Sway_R', 'Down']);
  root.add(hairMesh);
  const config = profile();
  delete config.humanoidCharacterization;
  const host = createRustEmbodyHostUnbound({ profileMode: 'profile', profile: config });
  t.after(() => { host.dispose(); hairMesh.geometry.dispose(); hairMesh.material.dispose(); });
  host.onReady({ model: root });
  assert.equal(actionId(host, HAIR_RESPONSE), undefined);
  const calls = spyHairWork(host);
  renderHostFrame(host, FRAME);
  assert.equal(calls.step, 0);
});

test('hair response creates no timers, intervals or animation frames', (t) => {
  const timers = ['setTimeout', 'setInterval', 'setImmediate', 'requestAnimationFrame']
    .filter((name) => typeof globalThis[name] === 'function')
    .map((name) => mock.method(globalThis, name));
  t.after(() => { for (const timer of timers) timer.mock.restore(); });
  const { host, head } = fixture(t, { idleSwayAmount: 0.2 });
  host.registerAnimationClips([headTurn('look', 0, 0.6)]);
  host.playAnimation('look');
  for (let frame = 0; frame < 20; frame += 1) { head.rotation.y += 0.01; renderHostFrame(host, FRAME); }
  host.setHairPhysicsConfig({ inertia: 1 });
  renderHostFrame(host, FRAME);
  for (const timer of timers) assert.equal(timer.mock.callCount(), 0, `${timer.mock.calls} timer calls`);
});

function near(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-5, `${message}: expected ${expected}, received ${actual}`);
}
