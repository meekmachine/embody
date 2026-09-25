import assert from 'node:assert/strict';
import { initEmbodyCore } from '@lovelace_lol/embody/wasm';

const wasm = await initEmbodyCore();
const request = (op, payload) => JSON.parse(wasm.embody_request(JSON.stringify({ op, payload })));
const expand = (config) => request('profile.extendConfig', { config });
const model = JSON.stringify({ bones: [
  { id: 1, name: 'CC_Base_Head' }, { id: 2, name: 'CC_Base_L_Forearm' },
] });
const runtime = new wasm.RuntimeCore(0);

try {
  for (const nested of [false, true]) {
    for (const all of [false, true]) {
      const bodyControls = all
        ? { 'body.elbowFlex': null, 'body.kneeBend': null, 'body.torsoTwist': null }
        : { 'body.kneeBend': null };
      const override = nested ? { profile: { bodyControls } } : { bodyControls };
      const profile = expand({ auPresetType: 'cc4', ...override });
      const controls = request('profile.getBodyControls', { profile });
      assert.equal(controls.length, all ? 0 : 2);
      assert.equal(Object.hasOwn(profile.bodyControls, 'body.kneeBend'), false);
      assert.deepEqual(expand(JSON.parse(JSON.stringify(profile))).bodyControls, profile.bodyControls);
      runtime.configure_with_profile(JSON.stringify(profile), model);
    }

    const override = nested ? { profile: { compositeRotations: [] } } : { compositeRotations: [] };
    const profile = expand({ auPresetType: 'cc4', ...override });
    const edited = request('bone.classifyJointControl', { profile, auId: 1001 });
    assert.deepEqual(edited.compositeRotations, []);
    runtime.clear();
    runtime.configure_with_profile(JSON.stringify(edited), model);
    runtime.set_au(51, 0.5, 0);
    runtime.set_au(1001, 0.5, 0);
    assert.equal(runtime.evaluate_bone_frame_delta().length, 0);
  }

  for (const omitted of [false, true]) {
    const profile = JSON.parse(wasm.get_preset_json('cc4'));
    profile.compositeRotations = null;
    if (omitted) delete profile.compositeRotations;
    const edited = request('bone.applyAUBindingUpdate', { profile, auId: 999, update: {} });
    assert.equal(Object.hasOwn(edited, 'compositeRotations'), false);
    runtime.clear();
    runtime.configure_with_profile(JSON.stringify(edited), model);
    runtime.set_au(51, 0.5, 0);
    const head = Array.from(runtime.evaluate_bone_frame_delta()).slice(0, 9);
    assert.equal(head[0], 1);
    assert(Math.abs(head[5]) > 0.01, 'omitted/null table keeps legacy head rotation');
  }

  runtime.clear();
  assert.equal(runtime.get_au_balance(1001), 0);
  runtime.set_au(1001, 0.5, -0.75);
  assert.equal(runtime.get_au_balance(1001), -0.75);
  runtime.set_continuum(1003, 1004, -0.5, 0.25);
  assert.equal(runtime.get_au_balance(1003), 0.25);
  assert.equal(runtime.get_au_balance(1004), 0.25);
  runtime.configure_with_preset('cc4', '{}', model);
  assert.equal(runtime.get_au_balance(1001), -0.75);
  runtime.clear();
  assert.equal(runtime.get_au_balance(1001), 0);
} finally {
  runtime.free();
}

console.log('Body control profile and runtime smoke passed');
