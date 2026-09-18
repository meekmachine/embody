import * as THREE from 'three';
import {
  ThreeFrameApplier,
  ThreeModelInspector,
} from '@lovelace_lol/embody/three';

export const MORPH_COUNT = 64;
export const FIRST_AU = 200;
export const DT_SECONDS = 1 / 60;

// Stable names and one-to-one mappings make every expected output independent
// of the runtime's evaluation code. No character assets or renderer are needed.
export function createCharacter(wasm) {
  const model = new THREE.Group();
  model.name = 'BenchmarkCharacter';
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0, 1, 0, 0, 0, 1, 0,
  ], 3));
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  mesh.name = 'BenchmarkFace';
  mesh.morphTargetDictionary = Object.fromEntries(
    Array.from({ length: MORPH_COUNT }, (_, index) => [`morph${index}`, index]),
  );
  mesh.morphTargetInfluences = Array(MORPH_COUNT).fill(0);
  model.add(mesh);
  const profile = {
    auToMorphs: Object.fromEntries(Array.from({ length: MORPH_COUNT }, (_, index) => [
      FIRST_AU + index, { left: [], right: [], center: [`morph${index}`] },
    ])),
    auToBones: {},
    boneNodes: {},
    compositeRotations: [],
    morphToMesh: { face: ['BenchmarkFace'] },
    meshes: { BenchmarkFace: { category: 'face' } },
    hairPhysics: { enabled: false },
  };
  const inspection = new ThreeModelInspector().inspectModel(model, { profile });
  const core = new wasm.RuntimeCore(0);
  try {
    core.configure_with_profile(JSON.stringify(profile), JSON.stringify(inspection.descriptor));
  } catch (error) {
    core.free();
    geometry.dispose();
    mesh.material.dispose();
    throw error;
  }
  const applier = new ThreeFrameApplier();
  applier.setBindings(inspection);
  const mixer = new THREE.AnimationMixer(model);
  return {
    model, mesh, inspection, core, mixer,
    flushFull() {
      applier.applyPackedMorphFrameDelta(core.evaluate_morph_frame_delta());
      applier.applyPackedBoneFrameDelta(core.evaluate_bone_frame_delta());
      applier.applySceneFrame(core.evaluate_scene_frame());
      model.updateMatrixWorld(true);
    },
    tick() {
      core.update(DT_SECONDS);
      mixer.update(DT_SECONDS);
      applier.applyPackedMorphFrameDelta(core.evaluate_active_morph_frame());
      applier.applyPackedBoneFrameDelta(core.evaluate_active_bone_frame());
      model.updateMatrixWorld(true);
    },
    dispose() {
      mixer.stopAllAction();
      mixer.uncacheRoot(model);
      core.free();
      geometry.dispose();
      mesh.material.dispose();
    },
  };
}

export function controlValue(frame, control, character) {
  // Includes both endpoints, including a release to zero, and changes on every
  // frame. Different characters receive different but reproducible commands.
  return ((frame * 7 + control * 13 + character * 17) % 96) / 95;
}

export function runFrame(characters, activeControls, mode, frame) {
  for (let characterIndex = 0; characterIndex < characters.length; characterIndex += 1) {
    const character = characters[characterIndex];
    for (let control = 0; control < activeControls; control += 1) {
      character.core.set_au_signed(FIRST_AU + control, controlValue(frame, control, characterIndex), 0);
      if (mode === 'per-setter') character.flushFull();
    }
    if (mode === 'one-flush' && activeControls > 0) character.flushFull();
    character.tick();
  }
}

export function createCurves(controlCount = 32) {
  return Object.fromEntries(Array.from({ length: controlCount }, (_, control) => [
    FIRST_AU + control,
    Array.from({ length: 5 }, (_, key) => ({
      time: key / 4,
      intensity: controlValue(key, control, 0),
    })),
  ]));
}
