import assert from 'node:assert/strict';
import test from 'node:test';
import { renderHostFrame } from './helpers/render-playback.mjs';
import { Bone, Group, Mesh, BufferGeometry, MeshBasicMaterial } from 'three';
import {
  CC4_HUMANOID_SKELETON_TEMPLATE,
  createRustEmbodyHost,
  extendCharacterConfigWithPreset,
  getAUDescriptors,
  ThreeModelInspector,
  getHumanoidSpecification,
  getPreset,
  resolveHumanoidCharacterization,
  setHumanoidRoleBinding,
  setAUMorphTargets,
  getMeshNamesForAUProfile,
  validateHumanoidCharacterization,
} from '@lovelace_lol/embody/three';
import { initEmbodyCore } from '@lovelace_lol/embody/wasm';

await initEmbodyCore();

function cc4Model() {
  const root = new Group();
  const bones = new Map(CC4_HUMANOID_SKELETON_TEMPLATE.bones.map(({ name, translation }) => {
    const bone = new Bone();
    bone.name = name;
    bone.position.fromArray(translation);
    return [name, bone];
  }));
  for (const { name, parent } of CC4_HUMANOID_SKELETON_TEMPLATE.bones) {
    (bones.get(parent) ?? root).add(bones.get(name));
  }
  root.updateMatrixWorld(true);
  return { root, bones };
}

function snapshot(bone) {
  return [...bone.position.toArray(), ...bone.quaternion.toArray(), ...bone.scale.toArray()];
}

function changed(before, bone) {
  return snapshot(bone).some((value, index) => Math.abs(value - before[index]) > 1e-7);
}

test('published semantic specification covers all VRM roles and conditional parents', () => {
  const spec = getHumanoidSpecification();
  assert.equal(spec.standard, 'VRMC_vrm-1.0');
  assert.equal(spec.bones.length, 55);
  assert.equal(new Set(spec.bones.map(bone => bone.role)).size, 55);
  const required = spec.bones.filter(bone => bone.required).map(bone => bone.role).sort();
  assert.deepEqual(required, [
    'hips', 'spine', 'head',
    'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm', 'rightHand',
    'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot',
  ].sort());
  const definitions = new Map(spec.bones.map(bone => [bone.role, bone]));
  assert.equal(definitions.get('upperChest').parent, 'chest');
  assert.equal(definitions.get('upperChest').requiresParent, true);
  assert.equal(definitions.get('neck').requiresParent, false);
  assert.equal(definitions.get('leftThumbProximal').parent, 'leftThumbMetacarpal');
  assert.equal(definitions.get('rightLittleDistal').requiresParent, true);
  assert.equal(definitions.get('leftIndexProximal').requiresParent, false);
  assert.deepEqual(new Set(spec.bones.map(bone => bone.section)),
    new Set(['Torso', 'Head', 'Arms', 'Hands', 'Legs', 'Feet']));
});

test('every CC4 semantic role has a unique real template bone and a working control', async () => {
  const profile = getPreset('cc4');
  const { root, bones } = cc4Model();
  const resolution = validateHumanoidCharacterization(root, profile);
  assert.equal(resolution.valid, true, JSON.stringify(resolution.errors));
  assert.equal(Object.keys(resolution.roles).length, 55);
  assert.equal(new Set(Object.values(resolution.roles).map(role => role.boneName)).size, 55);
  const controls = getAUDescriptors(profile, new ThreeModelInspector().inspectModel(root, { profile }).descriptor).filter(control => control.hasBones);
  const covered = new Set(controls.flatMap(control => control.boneNames));
  assert.deepEqual(covered, new Set(Object.values(resolution.roles).map(role => role.boneName)));
  const host = await createRustEmbodyHost(root, { profileMode: 'profile', profile });
  try {
    for (const control of controls) {
      assert.equal(control.hasBones, true, `${control.id}: ${control.diagnostics.join('; ')}`);
      for (const sign of [1]) {
        host.clear();
        renderHostFrame(host, 0);
        const targets = control.boneBindings.map(binding => bones.get(binding.boneName)).filter(Boolean);
        const before = new Map(targets.map(bone => [bone, snapshot(bone)]));
        host.setAU(control.auId, 0.4, 0);
        renderHostFrame(host, 0);
        assert.ok(targets.some(bone => changed(before.get(bone), bone)), `${control.id} direction ${sign} must move a bound bone`);
        assert.ok(targets.every(bone => snapshot(bone).every(Number.isFinite)), control.id);
        host.clear();
        renderHostFrame(host, 0);
        assert.ok(targets.every(bone => !changed(before.get(bone), bone)), `${control.id} clear restores the reference pose`);
      }
    }
  } finally {
    host.dispose();
  }
});

test('CC4 torso controls preserve hip and leg world transforms through the packaged runtime', async () => {
  const profile = extendCharacterConfigWithPreset({ auPresetType: 'cc4' });
  const { root, bones } = cc4Model();
  const controls = getAUDescriptors(profile, new ThreeModelInspector().inspectModel(root, { profile }).descriptor).filter(control => control.auId >= 1016 && control.auId <= 1027 || [1003,1004].includes(control.auId));
  assert.ok(controls.length > 0);
  const stationaryBones = [
    'CC_Base_Hip', 'CC_Base_Pelvis',
    'CC_Base_L_Thigh', 'CC_Base_R_Thigh',
    'CC_Base_L_Calf', 'CC_Base_R_Calf',
    'CC_Base_L_Foot', 'CC_Base_R_Foot',
  ].map(name => {
    assert.ok(bones.has(name), `template must include ${name}`);
    return bones.get(name);
  });
  const torsoBones = ['CC_Base_Waist', 'CC_Base_Spine01', 'CC_Base_Spine02'].map(name => bones.get(name));
  const host = await createRustEmbodyHost(root, { profileMode: 'profile', profile });
  try {
    for (const control of controls) {
      for (const sign of [1]) {
        host.clear();
        renderHostFrame(host, 0);
        root.updateMatrixWorld(true);
        const before = new Map(stationaryBones.map(bone => [bone, bone.matrixWorld.elements.slice()]));
        const torsoBefore = new Map(torsoBones.map(bone => [bone, snapshot(bone)]));
        host.setAU(control.auId, 0.4, 0);
        renderHostFrame(host, 0);
        root.updateMatrixWorld(true);
        assert.ok(torsoBones.some(bone => changed(torsoBefore.get(bone), bone)),
          `${control.id} direction ${sign} must move the torso`);
        for (const bone of stationaryBones) {
          assert.ok(bone.matrixWorld.elements.every((value, index) => Math.abs(value - before.get(bone)[index]) < 1e-7),
            `${control.id} direction ${sign} must leave ${bone.name} stationary`);
        }
      }
    }
  } finally {
    host.dispose();
  }
});

test('role assignment and clear survive JSON re-expansion and control the intended bone', async () => {
  const original = getPreset('cc4');
  const assigned = setHumanoidRoleBinding(original, 'leftLowerArm', 'CustomForearm');
  assert.notEqual(assigned, original);
  assert.equal(resolveHumanoidCharacterization(assigned).roles.leftLowerArm.boneName, 'CustomForearm');
  assert.equal(resolveHumanoidCharacterization(original).roles.leftLowerArm.boneName, 'CC_Base_L_Forearm');
  const restored = extendCharacterConfigWithPreset(JSON.parse(JSON.stringify({ auPresetType: 'cc4', ...assigned })));
  const model = new Group();
  const actual = new Bone();
  actual.name = 'CustomForearm';
  const old = new Bone();
  old.name = 'CC_Base_L_Forearm';
  const prefixedLookalike = new Bone();
  prefixedLookalike.name = 'CC_Base_CustomForearm';
  model.add(actual, old, prefixedLookalike);
  const host = await createRustEmbodyHost(model, { profileMode: 'profile', profile: restored });
  try {
    const start = snapshot(actual);
    const oldStart = snapshot(old);
    const lookalikeStart = snapshot(prefixedLookalike);
    host.setAU(1001, 0.5, -1);
    renderHostFrame(host, 0);
    assert.ok(changed(start, actual));
    assert.equal(changed(oldStart, old), false);
    assert.equal(changed(lookalikeStart, prefixedLookalike), false, 'an explicit selection must not target a prefixed lookalike');
    host.clear();
    const cleared = setHumanoidRoleBinding(restored, 'leftLowerArm', null);
    const savedClear = extendCharacterConfigWithPreset(JSON.parse(JSON.stringify({ auPresetType: 'cc4', ...cleared })));
    assert.equal(savedClear.humanoidCharacterization.authored, true);
    assert.equal(savedClear.humanoidCharacterization.roles.leftLowerArm, undefined);
    host.setProfile(savedClear);
    host.setAU(1001, 0.5, -1);
    renderHostFrame(host, 0);
    assert.equal(changed(start, actual), false);
    assert.equal(changed(oldStart, old), false);
    assert.equal(changed(lookalikeStart, prefixedLookalike), false, 'an explicit selection must not target a prefixed lookalike');
  } finally {
    host.dispose();
  }
});

test('exact empty imported profiles remain unmapped with the full catalog available', async () => {
  const host = await createRustEmbodyHost(new Group(), { profileMode: 'profile', profile: {} });
  try {
    assert.deepEqual(getAUDescriptors(host.getProfile()), []);
    assert.deepEqual(host.getProfile().humanoidCharacterization?.roles ?? {}, {});
    assert.equal(getHumanoidSpecification().bones.length, 55);
  } finally {
    host.dispose();
  }
});


test('semantic neck and eye mappings share authored AU morphs and edits preserve other actions', async () => {
  const profile = getPreset('cc4');
  assert.deepEqual(profile.auToMorphs['1033'], profile.auToMorphs['54']);
  assert.equal(profile.auMixDefaults['1033'], profile.auMixDefaults['54']);
  const eye = getAUDescriptors(profile).find(control => control.auId === 62);
  assert.deepEqual(new Set([eye.auId, eye.negativeAuId]), new Set([61, 62]));
  const { root, bones } = cc4Model();
  const mesh = new Mesh(new BufferGeometry(), new MeshBasicMaterial());
  mesh.name = getMeshNamesForAUProfile(profile, 54)[0];
  assert.equal(mesh.name, getMeshNamesForAUProfile(profile, 61)[0],
    'neck and eye morphs share the selected face mesh');
  mesh.morphTargetDictionary = { Head_Turn_Down: 0, Eye_L_Look_L: 1, Eye_R_Look_L: 2 };
  mesh.morphTargetInfluences = [0, 0, 0];
  root.add(mesh);
  const host = await createRustEmbodyHost(root, { profileMode: 'profile', profile });
  try {
    const neckName = resolveHumanoidCharacterization(profile).roles.neck.boneName;
    const neck = bones.get(neckName);
    const rest = snapshot(neck);
    host.setAU(1033, 0.5, 0);
    renderHostFrame(host, 0);
    assert.ok(changed(rest, neck));
    assert.ok(Math.abs(mesh.morphTargetInfluences[0] - 0.35) < 1e-5);
    host.setAUMixWeight(1033, 0.25);
    renderHostFrame(host, 0);
    assert.ok(Math.abs(mesh.morphTargetInfluences[0] - 0.125) < 1e-5);
    const edited = setAUMorphTargets(profile, 1033, 'center', []);
    assert.deepEqual(edited.auToMorphs['54'], profile.auToMorphs['54']);
    const saved = extendCharacterConfigWithPreset(JSON.parse(JSON.stringify({ auPresetType: 'cc4', ...edited })));
    assert.deepEqual(saved.auToMorphs['1033'].center, []);
    host.setProfile(saved);
    host.setAU(1033, 0.5, 0);
    renderHostFrame(host, 0);
    assert.equal(mesh.morphTargetInfluences[0], 0);
    host.setAU(54, 0.5, 0);
    renderHostFrame(host, 0);
    assert.ok(Math.abs(mesh.morphTargetInfluences[0] - 0.35) < 1e-5);
    host.clear();
    host.setAUMixWeight(61, 0.5);
    host.setAU(eye.negativeAuId, 0.5, -1);
    renderHostFrame(host, 0);
    assert.ok(Math.abs(mesh.morphTargetInfluences[1] - 0.25) < 1e-5, JSON.stringify({ weights: mesh.morphTargetInfluences, mix: host.getAUMixWeight(61), mapping: host.getProfile().auToMorphs[61] }));
    assert.equal(mesh.morphTargetInfluences[2], 0);
    const shared = setAUMorphTargets(profile, 1035, 'left', ['Head_Turn_L', 'CustomTissue']);
    assert.deepEqual(shared.auToMorphs['51'], profile.auToMorphs['51']);
    assert.deepEqual(shared.auToMorphs['1035'].left, ['Head_Turn_L', 'CustomTissue']);
  } finally {
    host.dispose();
    mesh.geometry.dispose();
    mesh.material.dispose();
  }
});
