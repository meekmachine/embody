import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { Timer } from 'three';
import { renderScenePlayback } from '@lovelace_lol/embody/three';

const frames = new WeakMap();

export function createPlaybackTimer() {
  // Match Timer's constructor origin to the supplied zero-based timestamps.
  const now = mock.method(performance, 'now', () => 0);
  try {
    return new Timer().update(0);
  } finally {
    now.mock.restore();
  }
}

// Exercise the same Three Timer and render integration as the character scene.
// This fixture supplies timestamps; characters expose no update/clock API.
export function renderHostFrame(host, seconds) {
  const model = host.model;
  assert.ok(model?.isObject3D, 'bound character exposes its Three model');
  let frame = frames.get(host);
  if (!frame || frame.model !== model) {
    frame = { model, timer: createPlaybackTimer(), milliseconds: 0 };
    frames.set(host, frame);
  }
  frame.milliseconds += seconds * 1000;
  frame.timer.update(frame.milliseconds);
  renderScenePlayback(model, frame.timer);
}
