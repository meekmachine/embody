import assert from 'node:assert/strict';
import { Object3D } from 'three';
import {
  BONE_AU_TO_BINDINGS,
  COMPOSITE_ROTATIONS,
  Loom3,
} from '../dist/index.js';
import { createAnimationRuntime, createClipPlan } from '../dist/cljs/index.js';

const planned = createClipPlan(
  'gaze/look',
  {
    43: [
      { time: 1.2, intensity: 1 },
      { time: 0, intensity: 0, inherit: true },
    ],
  },
  { loopMode: 'once', weight: 0.75, playbackRate: 1.5, source: 'snippet' },
);

assert.deepEqual(planned.keyframeTimes, [0, 1.2]);
assert.equal(planned.duration, 1.2);
assert.equal(planned.hasInheritedStart, true);
assert.deepEqual(planned.inheritedCurveIds, ['43']);
assert.equal(planned.playback.playbackRate, 1.5);
assert.equal(planned.playback.weight, 0.75);

const commands = [];
const connectorCalls = [];
const runtime = createAnimationRuntime({}, {
  buildClip(name, curves, options) {
    connectorCalls.push(['buildClip', name, curves, options]);
    return { actionId: `${name}:action`, duration: 1.2 };
  },
  setClipWeight(name, weight) {
    connectorCalls.push(['setClipWeight', name, weight]);
  },
  setClipPlaybackRate(name, rate) {
    connectorCalls.push(['setClipPlaybackRate', name, rate]);
  },
  setClipLoop(name, mode, repeatCount) {
    connectorCalls.push(['setClipLoop', name, mode, repeatCount]);
  },
  setClipTime(name, time) {
    connectorCalls.push(['setClipTime', name, time]);
  },
  pauseClip(name) {
    connectorCalls.push(['pauseClip', name]);
  },
  resumeClip(name) {
    connectorCalls.push(['resumeClip', name]);
  },
  stopClip(name) {
    connectorCalls.push(['stopClip', name]);
  },
  onCommand(command) {
    commands.push(command);
  },
});

const handle = runtime.buildClip(
  'gaze/look',
  {
    43: [
      { time: 0, intensity: 0, inherit: true },
      { time: 1.2, intensity: 1 },
    ],
  },
  { loopMode: 'once', weight: 0.75, playbackRate: 1.5, source: 'snippet' },
);

assert.equal(handle.clipName, 'gaze/look');
assert.equal(handle.actionId, 'gaze/look:action');
assert.equal(handle.getDuration(), 1.2);
assert.equal(connectorCalls[0][0], 'buildClip');
assert.equal(connectorCalls[0][3].playbackRate, 1.5);
assert.equal(connectorCalls[0][3].speed, 1.5);
assert.equal(connectorCalls[0][3].weight, 0.75);
assert.equal(connectorCalls[0][3].mixerWeight, 0.75);
assert.equal(connectorCalls[0][3].clipPlan.duration, 1.2);
assert.deepEqual(connectorCalls[0][3].clipPlan.keyframeTimes, [0, 1.2]);
assert.equal(commands.some((command) => command.op === 'buildClip'), true);

const events = [];
const unsubscribe = handle.subscribe((event) => events.push(event));
handle.setWeight(0.4);
handle.setPlaybackRate(2);
handle.setLoop('repeat', 3);
handle.setTime(0.5);
handle.pause();
handle.resume();
runtime.acceptClipEvent({ type: 'progress', clipName: 'gaze/look', currentTime: 0.7 });
runtime.acceptClipEvent({ type: 'completed', clipName: 'gaze/look' });
unsubscribe();
handle.stop();

await handle.finished;

const snapshot = runtime.snapshot();
assert.equal(snapshot.handles['gaze/look'].status, 'stopped');
assert.equal(snapshot.handles['gaze/look'].time, 1.2);
assert.equal(events.length, 2);
assert.equal(connectorCalls.some((call) => call[0] === 'setClipWeight' && call[2] === 0.4), true);
assert.equal(connectorCalls.some((call) => call[0] === 'setClipPlaybackRate' && call[2] === 2), true);
assert.equal(connectorCalls.some((call) => call[0] === 'setClipLoop' && call[2] === 'repeat' && call[3] === 3), true);
assert.equal(connectorCalls.some((call) => call[0] === 'setClipTime' && call[2] === 0.5), true);
assert.equal(connectorCalls.some((call) => call[0] === 'pauseClip'), true);
assert.equal(connectorCalls.some((call) => call[0] === 'resumeClip'), true);
assert.equal(connectorCalls.some((call) => call[0] === 'stopClip'), true);

console.log('CLJS animation runtime smoke passed');

const model = new Object3D();
const leftEye = new Object3D();
leftEye.name = 'CC_Base_L_Eye';
model.add(leftEye);

const loom = new Loom3({
  animationRuntimeFactory: createAnimationRuntime,
  profile: {
    auToMorphs: {},
    auToBones: BONE_AU_TO_BINDINGS,
    boneNodes: { EYE_L: 'CC_Base_L_Eye' },
    morphToMesh: {},
    visemeKeys: [],
    compositeRotations: COMPOSITE_ROTATIONS,
  },
});

loom.onReady({ meshes: [], model });

const integratedHandle = loom.buildClip(
  'cljs-integrated-eye',
  {
    65: [
      { time: 0, intensity: 0 },
      { time: 0.5, intensity: 1 },
      { time: 1, intensity: 0 },
    ],
  },
  { loopMode: 'once', source: 'snippet', playbackRate: 2, weight: 0.5 },
);

assert.ok(integratedHandle);
assert.equal(typeof integratedHandle.subscribe, 'function');
assert.equal(loom.getAnimationState('cljs-integrated-eye').playbackRate, 2);
assert.equal(loom.getAnimationState('cljs-integrated-eye').weight, 0.5);

const integratedEvents = [];
integratedHandle.subscribe((event) => integratedEvents.push(event));

loom.update(0.25);
assert.notEqual(leftEye.quaternion.w, 1);
loom.update(0.25);

assert.equal(integratedEvents.some((event) => event.type === 'keyframe' && event.currentTime === 0.5), true);
assert.equal(integratedEvents.some((event) => event.type === 'completed'), true);

console.log('CLJS runtime wired to Three animation smoke passed');
