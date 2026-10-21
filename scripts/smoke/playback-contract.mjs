import assert from 'node:assert/strict';
import { initEmbodyCore } from '@lovelace_lol/embody/wasm';

// A non-Three connector contract fixture: it owns native resources and delivers
// explicit native events. There is deliberately no clock, sampler or update.
class FakeConnector {
  constructor(session) {
    this.session = session;
    this.resources = new Map();
    this.events = [];
    this.failRelease = false;
    this.dispatchDepth = 0;
    this.nativeNotifications = [];
    this.onTerminal = () => {};
  }

  dispatch(serialized, { defer = false, failPlay = false } = {}) {
    const batch = JSON.parse(serialized);
    this.dispatchDepth += 1;
    try {
      for (const command of batch.commands) {
        if (command.type === 'play') {
          const resource = { ...command, prepared: !defer, paused: false };
          this.resources.set(command.handle, resource);
          // Completion of asynchronous materialization must check ownership again.
          resource.finishPreparation = () => {
            if (this.resources.get(command.handle) !== resource) return false;
            resource.prepared = true;
            return true;
          };
          if (failPlay) this.emit(command.handle, 'error', 'native allocation failed');
        } else if (command.type === 'release') {
          // Keep failed cleanup owned and surface it before delivering events.
          if (this.failRelease) throw new Error('native release failed');
          this.resources.delete(command.handle);
        } else if (command.type === 'control') {
          const resource = this.resources.get(command.handle);
          assert(resource, 'control must refer to an owned native resource');
          const control = command.control;
          switch (control.type) {
            case 'pause': resource.paused = true; break;
            case 'resume': resource.paused = false; break;
            case 'seek': resource.positionSeconds = control.seconds; break;
            case 'setSpeed': resource.settings.speed = control.speed; break;
            case 'setWeight': resource.settings.weight = control.weight; break;
            case 'setBlendMode': resource.settings.blendMode = control.blendMode; break;
            case 'setLoop': resource.settings.loop = control.loop; break;
            case 'setFinalPose': resource.settings.finalPose = control.finalPose; break;
            default: assert.fail(`Unsupported native control: ${control.type}`);
          }
        } else assert.fail(`Unsupported native command: ${command.type}`);
      }
      // Reentrant observers see all effects of this batch already applied.
      for (const event of batch.events) {
        this.events.push(event);
        this.onTerminal(event);
      }
    } finally {
      this.dispatchDepth -= 1;
    }
    // Synchronous native callbacks must not interrupt command/event delivery.
    while (this.dispatchDepth === 0 && this.nativeNotifications.length) {
      const event = this.nativeNotifications.shift();
      this.emit(event.handle, event.type, event.message);
    }
    return batch;
  }

  emit(handle, type, message) {
    const event = { handle, type, ...(message ? { message } : {}) };
    if (this.dispatchDepth > 0) {
      this.nativeNotifications.push(event);
      return;
    }
    return this.dispatch(this.session.notify(JSON.stringify(event)));
  }

  control(handle, control) {
    return this.dispatch(this.session.control(handle, JSON.stringify(control)));
  }

  terminalEvents(handle) { return this.events.filter((event) => event.handle === handle); }
}

const wasm = await initEmbodyCore();
const runtime = new wasm.RuntimeCore(0);
const session = new wasm.NativePlaybackSession();
const foreign = new wasm.NativePlaybackSession();
const connector = new FakeConnector(session);
connector.onTerminal = ({ handle, type }) => {
  const resource = connector.resources.get(handle);
  if (type === 'completed' && resource?.settings.finalPose === 'hold') return;
  assert.equal(resource, undefined, 'released native resource is gone before terminal delivery');
};
try {
  // Distinct semantic AUs intentionally contribute tracks to the same target.
  runtime.load_au_morph_bindings(new Float32Array([12, 2, 2, 3, 1, 13, 2, 2, 3, 1]));
  const points = [
    { time: 0, intensity: 0 }, { time: 0.5, intensity: 0.25 },
    { time: 0.5, intensity: 0.75 }, { time: 1, intensity: 1 },
  ];
  const clipJson = runtime.build_clip('shared-smile', JSON.stringify({ 12: points, 13: points }), '{"intensityScale":0.5}');
  const compiled = JSON.parse(clipJson);
  assert.equal(compiled.tracks.length, 2);
  assert.deepEqual(compiled.tracks[0].target, compiled.tracks[1].target);
  assert.deepEqual(compiled.tracks[0].times, [0, 0.5, 0.5, 1]);
  assert.deepEqual(compiled.tracks[0].values, [0, 0.125, 0.375, 0.5]);
  const play = (options = {}, dispatchOptions) => connector.dispatch(session.play(clipJson, JSON.stringify(options)), dispatchOptions);

  assert.throws(() => session.play(clipJson, '{}'), /Bind a model/);
  connector.dispatch(session.rebind('model-1', 'profile-1'));
  foreign.rebind('model-1', 'profile-1');
  const first = play({ speed: -2, weight: 0.25, blendMode: 'additive', loop: { mode: 'pingPong', count: 3 }, finalPose: 'hold' }).handle;
  const native = connector.resources.get(first);
  assert.deepEqual(native.clip, compiled, 'semantic compilation and all contributions remain intact');
  assert.deepEqual(native.binding, { modelKey: 'model-1', profileKey: 'profile-1' });
  assert.deepEqual(native.settings, { startSeconds: 1, speed: -2, weight: 0.25, blendMode: 'additive', loop: { mode: 'pingPong', count: 3 }, finalPose: 'hold' });
  connector.control(first, { type: 'pause' });
  assert.equal(native.paused, true);
  connector.control(first, { type: 'setSpeed', speed: 0 });
  connector.control(first, { type: 'resume' });
  assert.equal(native.paused, false);
  assert.equal(native.settings.speed, 0, 'resume preserves the independently requested native speed');
  connector.control(first, { type: 'seek', seconds: 0.75 });
  connector.control(first, { type: 'setWeight', weight: 0.6 });
  connector.control(first, { type: 'setBlendMode', blendMode: 'normal' });
  connector.control(first, { type: 'setLoop', loop: { mode: 'repeat' } });
  connector.control(first, { type: 'setFinalPose', finalPose: 'release' });
  assert.equal(native.positionSeconds, 0.75);
  assert.equal(native.settings.weight, 0.6);
  assert.equal(native.settings.blendMode, 'normal');
  assert.deepEqual(native.settings.loop, { mode: 'repeat', count: null });
  assert.deepEqual(native.clip, compiled, 'native weight does not recompile semantic strength');

  const overlap = play().handle;
  assert.notEqual(first, overlap, 'same clip names still get distinct handles');
  assert.equal(connector.resources.size, 2);
  for (const options of [
    { replace: first, weight: 2 }, { replace: first, startSeconds: -1 },
    { replace: first, intensity: 0.2 }, { replace: first, blendMode: 'custom' },
    { replace: first, loop: { mode: 'once', count: 2 } }, { replace: 'foreign' },
  ]) assert.throws(() => session.play(clipJson, JSON.stringify(options)));
  assert.throws(() => session.play('{"name":"bad"}', JSON.stringify({ replace: first })));
  connector.control(first, { type: 'pause' });
  assert.equal(connector.resources.size, 2, 'invalid replacement retains existing resources');
  const replacement = play({ replace: first }).handle;
  assert.equal(connector.resources.has(first), false);
  assert.equal(connector.resources.has(overlap), true);
  assert.equal(connector.terminalEvents(first)[0].reason, 'replaced');
  assert.deepEqual(connector.emit(first, 'completed'), { commands: [], events: [] });
  assert.equal(connector.resources.has(replacement), true);
  assert.throws(() => session.control(first, '{"type":"resume"}'), /stale/);
  connector.emit(replacement, 'completed');
  connector.emit(replacement, 'completed');
  assert.equal(connector.terminalEvents(replacement).length, 1);
  assert.equal(connector.resources.has(replacement), false);

  const held = play({ finalPose: 'hold' }).handle;
  assert.deepEqual(connector.emit(held, 'completed').commands, []);
  assert.equal(connector.resources.has(held), true);
  assert.throws(() => session.control(held, '{"type":"resume"}'), /Completed held/);
  connector.emit(held, 'error', 'device lost after held completion');
  assert.equal(connector.resources.has(held), false);
  assert.equal(connector.terminalEvents(held).length, 1, 'late held error releases without a second terminal');
  const heldRelease = play({ finalPose: 'hold' }).handle;
  connector.emit(heldRelease, 'completed');
  connector.control(heldRelease, { type: 'setFinalPose', finalPose: 'release' });
  assert.equal(connector.resources.has(heldRelease), false);
  assert.equal(connector.terminalEvents(heldRelease).length, 1);

  const failed = play({}, { failPlay: true }).handle;
  assert.equal(connector.resources.has(failed), false);
  assert.deepEqual(connector.terminalEvents(failed), [{ type: 'error', handle: failed, message: 'native allocation failed' }]);
  const foreignHandle = JSON.parse(foreign.play(clipJson, '{}')).handle;
  assert.throws(() => session.control(foreignHandle, '{"type":"pause"}'), /foreign/);
  assert.deepEqual(connector.emit(foreignHandle, 'completed'), { commands: [], events: [] });

  const pendingStop = play({}, { defer: true }).handle;
  const finishStopped = connector.resources.get(pendingStop).finishPreparation;
  connector.control(pendingStop, { type: 'stop' });
  assert.equal(finishStopped(), false, 'stop invalidates queued native preparation');
  assert.equal(connector.terminalEvents(pendingStop)[0].reason, 'stopped');
  const pendingRebind = play({}, { defer: true }).handle;
  const finishRebound = connector.resources.get(pendingRebind).finishPreparation;
  connector.dispatch(session.rebind('model-1', 'profile-2'));
  assert.equal(finishRebound(), false, 'profile replacement invalidates pending preparation');
  assert.equal(connector.resources.size, 0);
  assert.equal(connector.terminalEvents(overlap)[0].reason, 'rebound');
  assert.deepEqual(connector.emit(pendingRebind, 'completed'), { commands: [], events: [] });
  const afterRebind = play().handle;
  assert.notEqual(afterRebind, overlap);

  for (const control of [
    { type: 'seek', seconds: 2 }, { type: 'setWeight', weight: -0.1 },
    { type: 'setLoop', loop: { mode: 'repeat', count: 0 } },
    { type: 'pause', fadeSeconds: 1 }, { type: 'update', seconds: 0.01 },
  ]) assert.throws(() => session.control(afterRebind, JSON.stringify(control)));
  assert.throws(() => session.control(afterRebind, '{"type":"setSpeed","speed":1e999}'));
  assert.throws(() => session.notify(JSON.stringify({ type: 'error', handle: afterRebind, message: '' })));
  assert.throws(() => session.notify(JSON.stringify({ type: 'finished', handle: afterRebind })));

  // Native clips may use an explicit duration shorter than their last key.
  const cutoff = { ...compiled, durationSeconds: 0.75 };
  const cutoffBatch = connector.dispatch(session.play(JSON.stringify(cutoff), '{"speed":0}'));
  assert.deepEqual(cutoffBatch.commands[0].clip, cutoff);
  assert.throws(() => session.control(cutoffBatch.handle, '{"type":"seek","seconds":1}'));
  const zero = structuredClone(compiled);
  zero.durationSeconds = 0;
  for (const track of zero.tracks) { track.times = [0]; track.values = [0.5]; }
  assert.throws(() => session.play(JSON.stringify(zero), '{"loop":{"mode":"repeat"}}'));
  const zeroHandle = connector.dispatch(session.play(JSON.stringify(zero), '{"finalPose":"hold"}')).handle;
  connector.emit(zeroHandle, 'completed');
  connector.control(zeroHandle, { type: 'stop' });
  assert.equal(connector.terminalEvents(zeroHandle).length, 1);

  // The protocol cannot promise success for effects a connector fails to apply.
  const cleanupHandle = play().handle;
  const cleanupBatch = session.control(cleanupHandle, '{"type":"stop"}');
  connector.failRelease = true;
  assert.throws(() => connector.dispatch(cleanupBatch), /native release failed/);
  assert.equal(connector.resources.has(cleanupHandle), true, 'connector retains failed cleanup ownership');
  assert.equal(connector.terminalEvents(cleanupHandle).length, 0, 'failed release does not deliver its terminal event');
  connector.failRelease = false;
  // This single-effect batch remains pending until its release succeeds.
  connector.dispatch(cleanupBatch);
  assert.equal(connector.resources.has(cleanupHandle), false);
  assert.equal(connector.terminalEvents(cleanupHandle).length, 1);

  const pendingDispose = play({}, { defer: true }).handle;
  const finishDisposed = connector.resources.get(pendingDispose).finishPreparation;
  connector.dispatch(session.dispose());
  assert.equal(finishDisposed(), false);
  assert.equal(connector.resources.size, 0);
  assert.deepEqual(connector.dispatch(session.dispose()), { commands: [], events: [] });
  assert.deepEqual(connector.emit(pendingDispose, 'completed'), { commands: [], events: [] });
  assert.throws(() => session.play(clipJson, '{}'), /disposed/);
  assert.throws(() => session.rebind('model', 'profile'), /disposed/);
  assert.throws(() => session.control(afterRebind, '{"type":"pause"}'), /disposed/);
} finally {
  connector.failRelease = false;
  connector.dispatch(session.dispose());
  foreign.dispose();
  session.free();
  foreign.free();
  runtime.free();
}
console.log('Native playback protocol, compiled contributions and connector lifecycle passed');
