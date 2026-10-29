import { renderHostFrame } from './helpers/render-playback.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { AnimationClip, AnimationMixer, BufferGeometry, Group, Mesh, MeshBasicMaterial, NumberKeyframeTrack } from 'three';
import { createRustEmbodyHost, getAUDescriptors, getMeshNamesForAUProfile, getPreset } from '@lovelace_lol/embody/three';
import { initEmbodyCore } from '@lovelace_lol/embody/wasm';

await initEmbodyCore();

function morphOnlyCharacter() {
  const profile = structuredClone(getPreset('cc4'));
  const controls = getAUDescriptors(profile);
  const actions = new Set(controls.flatMap(control => [control.auId]));
  const targets = [...actions].flatMap(id => ['L', 'R', 'C'].map(side => `Authored_${id}_${side}`));
  const categories = new Set();
  profile.auToBones = {};
  profile.compositeRotations = [];
  profile.auToMorphs = {};
  for (const id of actions) {
    profile.auInfo[id] = { ...profile.auInfo[id], faceArea: 'Body' };
    profile.auToMorphs[id] = {
      left: [`Authored_${id}_L`], right: [`Authored_${id}_R`], center: [`Authored_${id}_C`],
    };
    categories.add(profile.auFacePartToMeshCategory?.[profile.auInfo[id].facePart] ?? 'face');
  }
  profile.morphToMesh = Object.fromEntries([...categories].map(category => [category, [`${category}Skin`, `${category}Clothing`]]));
  const root = new Group();
  const meshes = [...categories].flatMap(category => profile.morphToMesh[category]).concat('UnassignedMesh').map(name => {
    const mesh = new Mesh(new BufferGeometry(), new MeshBasicMaterial());
    mesh.name = name;
    mesh.morphTargetDictionary = Object.fromEntries(targets.map((target, index) => [target, index]));
    mesh.morphTargetInfluences = targets.map(() => 0);
    root.add(mesh);
    return mesh;
  });
  return { profile, controls, root, meshes };
}

function close(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) < 1e-6, `${label}: expected ${expected}, got ${actual}`);
}

test('all authored AU mappings drive saved morph-only mappings through the packaged runtime', async () => {
  const { profile, controls, root, meshes } = morphOnlyCharacter();
  const host = await createRustEmbodyHost(root, { profileMode: 'profile', profile: JSON.parse(JSON.stringify(profile)) });
  try {
    assert.equal(controls.length, new Set([...Object.keys(profile.auInfo), ...Object.keys(profile.auToMorphs)].map(Number)).size);
    assert.ok(host.getAUDescriptors().every(control => control.hasMorphs && !control.hasBones && control.available));
    const eye = controls.find(control => control.auId === 62);
    assert.deepEqual(getMeshNamesForAUProfile(profile, eye.auId), profile.morphToMesh.face,
      'the explicit face selection owns eye morphs too');
    for (const control of controls) {
      for (const direction of [1]) {
        const id = direction < 0 ? control.negativeAuId : control.auId;
        const selectedMeshes = getMeshNamesForAUProfile(profile, id);
        for (const balance of control.bilateral ? [-1, 0, 1] : [0]) {
          for (const row of host.getAUDescriptors()) host.setAU(row.auId, 0, 0);
          host.setAUMixWeight(id, 0.25);
          host.setAU(id, 0.8, balance);
          renderHostFrame(host, 0);
          for (const mesh of meshes) {
            const assigned = selectedMeshes.includes(mesh.name);
            for (const [side, value] of [['L', balance > 0 ? 0 : 0.2], ['R', balance < 0 ? 0 : 0.2], ['C', 0.2]]) {
              const index = mesh.morphTargetDictionary[`Authored_${id}_${side}`];
              close(mesh.morphTargetInfluences[index], assigned ? value : 0, `AU${control.auId}/${direction}/${balance}/${mesh.name}/${side}`);
            }
          }
          host.setAUMixWeight(id, 0);
          renderHostFrame(host, 0);
          assert.ok(meshes.every(mesh => mesh.morphTargetInfluences.every(value => Math.abs(value) < 1e-6)), `AU${control.auId}: strength zero clears the current deformation`);
        }
      }
    }
    for (const row of host.getAUDescriptors()) host.setAU(row.auId, 0, 0);
    const elbowCategory = profile.auFacePartToMeshCategory?.[profile.auInfo[1001].facePart] ?? 'face';
    const previewMeshes = profile.morphToMesh[elbowCategory];
    const skin = meshes.find(mesh => mesh.name === previewMeshes[0]);
    const leftIndex = skin.morphTargetDictionary.Authored_1001_L;
    const rightIndex = skin.morphTargetDictionary.Authored_1001_R;
    host.setAUMixWeight(1001, 0.25);
    host.setAU(1001, 0.8, 0);
    host.setMorph('Authored_1001_R', 0.6, previewMeshes);
    host.setMorph('Authored_1001_L', 1, previewMeshes);
    renderHostFrame(host, 0);
    close(skin.morphTargetInfluences[leftIndex], 1, 'direct preview overrides the action');
    host.setMorph('Authored_1001_L', 0, previewMeshes);
    renderHostFrame(host, 0);
    close(skin.morphTargetInfluences[leftIndex], 0, 'explicit zero retains override ownership');
    host.releaseMorph('Authored_1001_L', previewMeshes);
    renderHostFrame(host, 0);
    close(skin.morphTargetInfluences[leftIndex], 0.2, 'ending preview restores the live action');
    close(skin.morphTargetInfluences[rightIndex], 0.6, 'targeted release preserves another direct override');
    host.releaseMorph(rightIndex, previewMeshes);
    renderHostFrame(host, 0);
    close(skin.morphTargetInfluences[rightIndex], 0.2, 'indexed release also restores the live action');
    for (const row of host.getAUDescriptors()) host.setAU(row.auId, 0, 0);
    for (const meshSelection of [[], ['MissingMesh']]) {
      const excluded = JSON.parse(JSON.stringify(profile));
      excluded.morphToMesh[elbowCategory] = meshSelection;
      host.setProfile(excluded);
      host.setAUMixWeight(1001, 1);
      host.setAU(1001, 1, 0);
      renderHostFrame(host, 0);
      assert.equal(host.getAUDescriptors().find(control => control.auId === 1001).hasMorphs, false);
      assert.ok(meshes.every(mesh => mesh.morphTargetInfluences.every(value => Math.abs(value) < 1e-6)), 'an explicit mesh selection must not fall back to excluded meshes');
      for (const row of host.getAUDescriptors()) host.setAU(row.auId, 0, 0);
    }
    const cleared = JSON.parse(JSON.stringify(profile));
    cleared.auToMorphs[1001] = { left: [], right: [], center: [] };
    host.setProfile(cleared);
    host.setAUMixWeight(1001, 1);
    host.setAU(1001, 1, 0);
    renderHostFrame(host, 0);
    assert.equal(host.getAUDescriptors().find(control => control.auId === 1001).hasMorphs, false);
    assert.ok(meshes.every(mesh => mesh.morphTargetInfluences.every(value => Math.abs(value) < 1e-6)), 'cleared mappings stay cleared after profile reload');
  } finally {
    host.dispose();
    for (const mesh of meshes) { mesh.geometry.dispose(); mesh.material.dispose(); }
  }
});


for (const blendMode of ['replace', 'additive']) {
  for (const paused of [false, true]) {
    test(`preview release restores a ${paused ? 'paused' : 'playing'} constant ${blendMode} clip`, async (t) => {
      const { profile, root, meshes } = morphOnlyCharacter();
      const captured = new Set();
      const clipAction = AnimationMixer.prototype.clipAction;
      t.mock.method(AnimationMixer.prototype, 'clipAction', function (...args) {
        const action = clipAction.apply(this, args);
        captured.add(action);
        return action;
      });
      const host = await createRustEmbodyHost(root, { profileMode: 'profile', profile });
      const mesh = meshes.find(mesh => mesh.name === 'bodySkin');
      const target = 'Authored_1001_L';
      const other = 'Authored_1001_R';
      const index = mesh.morphTargetDictionary[target];
      const clips = [0.4, 0.8].map((value, i) => new AnimationClip(`Constant${i}`, 2, [
        // Hold a nonzero plateau to exercise unchanged native clip samples.
        new NumberKeyframeTrack(`${mesh.name}.morphTargetInfluences[${target}]`, [0, 0.1, 2], [0, value, value]),
      ]));
      try {
        host.registerAnimationClips(clips);
        const handles = clips.map(clip => host.playAnimation(clip.name, {
          loop: true, blendMode, mixerWeight: 0.5, fadeInSec: 0, fadeOutSec: 0,
        }));
        renderHostFrame(host, 0.25);
        if (paused) handles.forEach(handle => handle.pause());
        const expected = mesh.morphTargetInfluences[index];
        close(expected, 0.6, 'weighted constant clip sample');
        const bakedActions = [...captured];
        const actionState = () => bakedActions.map(action => ({
          enabled: action.enabled, paused: action.paused, time: action.time,
          timeScale: action.timeScale, weight: action.weight,
          effectiveWeight: action.getEffectiveWeight(), mixerTime: action.getMixer().time,
        }));
        const before = actionState();
        host.setMorph(other, 0.7, [mesh.name]);
        host.setMorph(target, 1, [mesh.name]);
        renderHostFrame(host, 0);
        close(mesh.morphTargetInfluences[index], blendMode === 'additive' ? 1.6 : 0.8,
          'live preview participates in native mixer blending');
        host.releaseMorph(target, [mesh.name]);
        renderHostFrame(host, 0);
        close(mesh.morphTargetInfluences[index], expected, 'release restores the clip sample on the render frame');
        assert.deepEqual(actionState(), before, 'release preserves playback state and clock');
        close(mesh.morphTargetInfluences[mesh.morphTargetDictionary[other]], 0.7, 'unrelated override survives mixer resampling');
        renderHostFrame(host, 0.1);
        close(mesh.morphTargetInfluences[index], expected, 'clip remains restored on following tick');
      } finally {
        host.dispose();
        for (const mesh of meshes) { mesh.geometry.dispose(); mesh.material.dispose(); }
      }
    });
  }
}


test('mapped AU previews and signed continuums share exclusive directions', async () => {
  const { profile, controls, root, meshes } = morphOnlyCharacter();
  const host = await createRustEmbodyHost(root, { profileMode: 'profile', profile });
  try {
    const directionalAUs = controls.filter(control => control.negativeAuId != null);
    assert.ok(directionalAUs.length > 0, 'the fixture must exercise mapped continuum pairs');
    // Each AU has its own row, including the negative member of a pair.
    // Exercise both rows using the pair identities supplied by the mapping.
    for (const control of directionalAUs) {
      const negative = control.negativeAuId;
      const positive = control.positiveAuId;
      const label = `AU${control.auId} (${control.label}; pair ${negative}/${positive})`;
      assert.ok(Number.isInteger(positive), `${label}: the mapped pair needs a positive AU`);
      assert.notEqual(negative, positive, `${label}: opposing directions need distinct AUs`);
      assert.ok([negative, positive].includes(control.auId), `${label}: the descriptor identifies one member`);
      for (const row of host.getAUDescriptors()) host.setAU(row.auId, 0, 0);
      host.setAUMixWeight(negative, 0.25);
      host.setAUMixWeight(positive, 0.5);
      const selectedMeshes = getMeshNamesForAUProfile(profile, positive);
      const mesh = meshes.find(mesh => mesh.name === selectedMeshes[0]);
      const weight = id => mesh.morphTargetInfluences[mesh.morphTargetDictionary[`Authored_${id}_C`]];
      host.setContinuum(negative, positive, -0.8, -0.5);
      host.setAU(positive, 0.6, 0.5);
      renderHostFrame(host, 0);
      close(host.getAU(negative), 0, `${label} inactive action`);
      close(weight(negative), 0, `${label} inactive tissue`);
      close(weight(positive), 0.3, `${label} active tissue strength`);
      close(host.getAUBalance(negative), 0.5, `${label} shared balance`);
      host.setAU(negative, 0, 0);
      renderHostFrame(host, 0);
      close(weight(positive), 0.3, `${label} inactive release preserves current direction`);
      host.setAU(negative, 0.4, 0);
      renderHostFrame(host, 0);
      close(weight(positive), 0, `${label} switching direction clears tissue`);
      close(weight(negative), 0.1, `${label} selected negative tissue`);
      host.setAU(negative, -0.2, 0);
      renderHostFrame(host, 0);
      close(weight(negative), 0, `${label} signed inverse clears tissue`);
      close(weight(positive), 0.1, `${label} signed inverse selects partner`);
      host.setContinuum(negative, positive, 0, 0);
      renderHostFrame(host, 0);
      close(weight(positive), 0, `${label} neutral continuum clears individual preview`);
    }
  } finally {
    host.dispose();
    for (const mesh of meshes) { mesh.geometry.dispose(); mesh.material.dispose(); }
  }
});
