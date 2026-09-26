import assert from 'node:assert/strict';
import { initEmbodyCore } from '@lovelace_lol/embody/wasm';

const wasm = await initEmbodyCore();
const core = new wasm.RuntimeCore(2);
try {
  core.load_viseme_morph_bindings(new Float32Array([0, 1, 2, 1]));
  for (const index of [0, 1, 999]) {
    assert.equal(core.get_viseme(index), 0);
    assert.equal(core.get_viseme_jaw_scale(index), 1);
  }
  assert.equal(core.evaluate_active_morph_frame().length, 0, 'reads do not activate a control');
  core.set_viseme(0, 0.75);
  core.set_viseme_jaw_scale(0, 0.25);
  const active = core.evaluate_active_morph_frame();
  assert.equal(core.get_viseme(0), 0.75);
  assert.equal(core.get_viseme_jaw_scale(0), 0.25);
  assert.deepEqual(core.evaluate_active_morph_frame(), active, 'snapshot reads do not alter packed output');
  core.transition_viseme(0, 0.5, 200, 0);
  assert.equal(core.get_viseme(0), 0.5, 'reads canonical immediate transition state');
  assert.equal(core.get_viseme_jaw_scale(0), 0);
  core.set_viseme(0, 0);
  core.set_viseme_jaw_scale(0, 1);
  assert.equal(core.evaluate_active_morph_frame().length, 0, 'restoring an unset value releases its active override');
  core.set_viseme(0, 2);
  core.set_viseme_jaw_scale(0, NaN);
  assert.equal(core.get_viseme(0), 1, 'reads the clamped Rust value');
  assert.equal(core.get_viseme_jaw_scale(0), 1, 'reads the sanitized Rust scale');
  core.clear();
  assert.equal(core.get_viseme(0), 0);
  assert.equal(core.get_viseme_jaw_scale(0), 1);
  console.log('Direct viseme state Wasm contract passed.');
} finally { core.free(); }
