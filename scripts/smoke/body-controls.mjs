import assert from 'node:assert/strict';
import { initEmbodyCore } from '@lovelace_lol/embody/wasm';

const wasm = await initEmbodyCore();
const request = (op, payload) => JSON.parse(wasm.embody_request(JSON.stringify({ op, payload })));
const expand = (config) => request('profile.extendConfig', { config });
const preset = request('preset.get', { id: 'cc4' });
const count = Object.keys(preset.bodyControls).length;
const model = JSON.stringify({ bones: [
  { id: 1, name: 'CC_Base_Head' }, { id: 2, name: 'CC_Base_L_Forearm' },
] });
const runtime = new wasm.RuntimeCore(0);

try {
  for (const nested of [false, true]) {
    for (const all of [false, true]) {
      const bodyControls = all
        ? Object.fromEntries(Object.keys(preset.bodyControls).map(id => [id, null]))
        : { 'body.kneeBend': null };
      const override = nested ? { profile: { bodyControls } } : { bodyControls };
      const profile = expand({ auPresetType: 'cc4', ...override });
      const controls = request('profile.getBodyControls', { profile });
      assert.equal(controls.length, all ? 0 : count - 1);
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

  runtime.configure_with_preset('cc4', '{}', model);
  runtime.set_continuum(51, 52, -0.8, 0);
  runtime.set_au_signed(52, 0.6, 0);
  assert.equal(runtime.get_au(51), 0, 'individual right command clears left');
  assert(Math.abs(runtime.get_au(52) - 0.6) < 1e-6);
  runtime.set_au_signed(51, 0, 0);
  assert(Math.abs(runtime.get_au(52) - 0.6) < 1e-6, 'inactive slider release preserves right');

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

const specification = request('humanoid.getSpecification', {});
assert.equal(specification.standard, 'VRMC_vrm-1.0');
assert.equal(specification.bones.length, 55);
assert.equal(specification.bones.filter(bone => bone.required).length, 15);
assert.equal(count, 58);
assert.deepEqual(new Set(Object.values(preset.bodyControls).flatMap(control => control.roles)),
  new Set(specification.bones.map(bone => bone.role)));
const completeModel = {
  bones: specification.bones.map((bone, index) => {
    const key = preset.humanoidCharacterization.roles[bone.role].nodeKey;
    return { id: index + 1, name: `${preset.bonePrefix}${preset.boneNodes[key]}` };
  }),
};
const completeControls = request('profile.getBodyControls', { profile: preset, model: completeModel });
assert(completeControls.every(control => control.hasBones), 'all 58 controls have real skeletal outputs');
let editedMorphs = request('profile.setAUMorphTargets', {
  profile: { auPresetType: 'cc4', profile: { auMixDefaults: { 61: 0.25 } } },
  auId: 61, side: 'left', targets: ['CustomEyeTissue'],
});
editedMorphs = expand(JSON.parse(JSON.stringify(editedMorphs)));
const eyeControl = request('profile.getBodyControls', { profile: editedMorphs })
  .find(control => control.auIds.includes(61));
assert(eyeControl.morphBindings.left.includes('CustomEyeTissue'));
assert.equal(editedMorphs.auMixDefaults[61], 0.25);
assert.deepEqual(editedMorphs.auToMorphs[61].right, ['Eye_R_Look_L']);
const clearedNeck = request('profile.setAUMorphTargets', {
  profile: editedMorphs, auId: 1035, side: 'left', targets: [],
});
const reloaded = expand(JSON.parse(JSON.stringify(clearedNeck)));
assert.deepEqual(reloaded.auToMorphs[1035].left, []);
assert.deepEqual(reloaded.auToMorphs[51].left, ['Head_Turn_L']);
const fullRuntime = new wasm.RuntimeCore(0);
try {
  fullRuntime.configure_with_profile(JSON.stringify(preset), JSON.stringify(completeModel));
  assert.deepEqual(JSON.parse(fullRuntime.get_body_controls_json()), completeControls);
  for (const control of completeControls) {
    fullRuntime.clear();
    fullRuntime.set_au(control.auId, 0.5, 0);
    assert(fullRuntime.evaluate_active_bone_frame().length > 0, `${control.id} must move`);
  }
  fullRuntime.clear();
  fullRuntime.configure_with_profile(JSON.stringify(preset), JSON.stringify(completeModel));
  assert.equal(fullRuntime.evaluate_procedural_bone_frame().length, 0);
  fullRuntime.set_au(1001, 0.5, -1);
  fullRuntime.set_au(12, 0.75, 0.25);
  assert(fullRuntime.evaluate_procedural_bone_frame().length > 0);
  fullRuntime.reset_body_controls();
  assert.equal(fullRuntime.get_au(1001), 0);
  assert.equal(fullRuntime.get_au_balance(1001), 0);
  assert.equal(fullRuntime.get_au(12), 0.75);
  assert(fullRuntime.evaluate_procedural_bone_frame().length > 0, 'reset releases previous body ownership');
  assert.equal(fullRuntime.evaluate_procedural_bone_frame().length, 0);
  assert.equal(fullRuntime.evaluate_procedural_morph_frame().length, 0);
  assert.equal(fullRuntime.release_procedural_morph_frame().length, 0);
  fullRuntime.reset_procedural_frame_tracking();
  let edited = request('profile.setHumanoidRoleBinding', { profile: preset, role: 'head', boneName: 'CustomHead' });
  assert.equal(request('profile.resolveHumanoidCharacterization', { profile: edited }).roles.head.boneName, 'CustomHead');
  const editedModel = { bones: [...completeModel.bones,
    { id: 100, name: 'CC_Base_CustomHead' }, { id: 101, name: 'CustomHead' }, { id: 102, name: 'head' }] };
  fullRuntime.clear();
  fullRuntime.configure_with_profile(JSON.stringify(edited), JSON.stringify(editedModel));
  fullRuntime.set_au(51, 0.5, 0);
  assert.equal(fullRuntime.evaluate_active_bone_frame()[0], 101, 'literal selected bone wins over prefixed twin');
  edited = request('profile.setHumanoidRoleBinding', { profile: edited, role: 'head', boneName: null });
  edited = expand(JSON.parse(JSON.stringify({ ...edited, auPresetType: 'cc4' })));
  assert.equal(Object.hasOwn(edited.humanoidCharacterization.roles, 'head'), false);
  fullRuntime.clear();
  fullRuntime.configure_with_profile(JSON.stringify(edited), JSON.stringify(editedModel));
  fullRuntime.set_au(51, 0.5, 0);
  assert.equal(fullRuntime.evaluate_active_bone_frame().length, 0, 'clear does not fall back to a bone literally named head');
  const staticProfile = request('profile.setHumanoidRoleBinding', { profile: {}, role: 'head', boneName: 'CustomHead' });
  assert.equal(staticProfile.auToBones, undefined, 'role authoring must not seed rig-specific motion into an explicit static profile');
} finally { fullRuntime.free(); }
console.log('Complete humanoid specification, controls, and role-authoring smoke passed');

const morphRuntime = new wasm.RuntimeCore(0);
try {
  const profile = {
    bodyControls: { 'body.elbowFlex': { label: 'Elbow', section: 'Arms', auId: 1001 } },
    auToMorphs: { 1001: { center: ['Flex'] } },
    morphToMesh: { face: ['Skin'] },
    auMixDefaults: { 1001: 0.25 },
  };
  const model = {
    meshes: [{ id: 1, name: 'Skin', morphTargetIds: [2] }],
    morphTargets: [{ id: 2, meshId: 1, name: 'Flex', hostIndex: 0 }],
  };
  morphRuntime.configure_with_profile(JSON.stringify(profile), JSON.stringify(model));
  morphRuntime.set_au(1001, 0.8, 0);
  const weight = () => morphRuntime.evaluate_active_morph_frame()[2];
  assert(Math.abs(weight() - 0.2) < 1e-6, 'morph-only Body actions honor saved strength');
  morphRuntime.set_morph('Flex', 1, '["Skin"]');
  assert.equal(weight(), 1);
  assert.equal(morphRuntime.release_morph('Flex', '["Skin"]'), 1);
  assert(Math.abs(weight() - 0.2) < 1e-6, 'preview release restores Body output');
  morphRuntime.set_morph_index(0, 0, '["Skin"]');
  assert.equal(weight(), 0, 'explicit zero remains an owned override');
  assert.equal(morphRuntime.release_morph_index(0, '["Skin"]'), 1);
  assert(Math.abs(weight() - 0.2) < 1e-6);
  profile.morphToMesh.face = [];
  morphRuntime.configure_with_profile(JSON.stringify(profile), JSON.stringify(model));
  assert.equal(morphRuntime.evaluate_active_morph_frame().length, 0, 'deselecting every Body mesh disables its morphs');
  assert.equal(JSON.parse(morphRuntime.get_body_controls_json())[0].hasMorphs, false);
} finally { morphRuntime.free(); }
console.log('Body morph strength, explicit mesh selection, and preview-release smoke passed');
