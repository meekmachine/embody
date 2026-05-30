import assert from 'node:assert/strict';
import { createAnimationRuntime } from '../dist/cljs/index.js';

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
