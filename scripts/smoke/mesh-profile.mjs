import assert from 'node:assert/strict';
import { Bone, BoxGeometry, Color, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, MultiplyBlending, NormalBlending, Skeleton, SkinnedMesh } from 'three';
import { ThreeFrameApplier } from '@lovelace_lol/embody/three';

const applier = new ThreeFrameApplier();
const model = new Group();
const mesh = (name, visible = true) => {
  const result = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
  result.name = name;
  result.visible = visible;
  model.add(result);
  return result;
};
const body = mesh('Body');
const secondBody = mesh('Body');
const occlusion = mesh('EyeOcclusion');
const unconfigured = mesh('Unconfigured', false);
const unnamed = mesh('');
const profile = JSON.parse(JSON.stringify({ meshes: {
  Body: { visible: false, material: { renderOrder: 0, opacity: 0, transparent: false, depthWrite: false, depthTest: false, blending: 'Multiply' } },
  EyeOcclusion: { visible: false },
  Missing: { visible: false },
} }));

try {
  body.renderOrder = secondBody.renderOrder = 9;
  applier.applyMeshMaterialConfigs(model, profile.meshes);
  for (const part of [body, secondBody]) {
    assert.equal(part.visible, false, 'binding a saved profile restores hidden meshes, including duplicate names');
    assert.equal(part.renderOrder, 0);
    assert.equal(part.material.opacity, 0);
    assert.equal(part.material.transparent, false);
    assert.equal(part.material.depthWrite, false);
    assert.equal(part.material.depthTest, false);
    assert.equal(part.material.blending, MultiplyBlending);
  }
  assert.equal(occlusion.visible, false, 'visibility does not require a material override');
  assert.equal(unconfigured.visible, false, 'omitted meshes retain their model state');
  assert.equal(unnamed.visible, true);

  applier.applyMeshMaterialConfigs(model, { Body: { visible: true, material: { renderOrder: -2, opacity: 0.7, transparent: true, depthWrite: true, depthTest: true, blending: 'Normal' } } });
  assert.equal(body.visible, true, 'replacing a profile can restore visible=true');
  assert.deepEqual(applier.getMeshMaterialConfig(model, 'Body'), { renderOrder: -2, opacity: 0.7, transparent: true, depthWrite: true, depthTest: true, blending: 'Normal' });
  assert.equal(body.material.blending, NormalBlending);
  assert.equal(occlusion.visible, false, 'an omitted visibility field does not force a mesh visible');
  applier.applyMeshMaterialConfigs(model, { EyeOcclusion: { material: { opacity: 0.2 } } });
  assert.equal(occlusion.visible, false, 'material-only entries preserve visibility');
  assert.equal(occlusion.material.opacity, 0.2);
} finally {
  model.traverse(object => {
    if (!object.isMesh) return;
    object.geometry.dispose();
    object.material.dispose();
  });
}
console.log('Saved mesh visibility and material profile smoke passed');

// Highlight resources are transient, isolated from shared source materials.
{
  const root = new Group();
  const shared = new MeshBasicMaterial();
  const first = new Mesh(new BoxGeometry(), shared);
  const second = new Mesh(first.geometry, shared);
  first.name = 'First'; second.name = 'Second';
  root.add(first, second);
  const frame = new ThreeFrameApplier();
  frame.highlightMesh(root, 'First', 0xd4a040, 0.35);
  const overlay = first.children[0];
  assert.equal(overlay.material.wireframe, true);
  assert.equal(overlay.geometry, first.geometry);
  assert.equal(overlay.material.depthWrite, false);
  assert.equal(overlay.material.opacity, 0.35);
  assert.ok(overlay.material.color.r < new Color(0xd4a040).r);
  assert.notEqual(first.material, shared);
  assert.equal(second.material, shared);
  frame.highlightMesh(root, 'First', 0xd4a040, 0.1);
  assert.equal(first.children[0], overlay, 'fades reuse the same overlay');
  assert.equal(overlay.material.opacity, 0.1);
  frame.setMeshMaterialConfig(root, 'First', { opacity: 0.4 });
  frame.highlightMesh(root, 'Second');
  assert.equal(first.children.length, 0);
  assert.equal(first.material, shared);
  assert.equal(first.material.opacity, 0.4, 'material edits survive highlight cleanup');
  frame.clearMeshHighlights();
  assert.equal(second.children.length, 0);
  assert.equal(second.material, shared);
  first.geometry.dispose(); shared.dispose();
}

{
  const root = new Group();
  const geometry = new BoxGeometry();
  const original = new MeshStandardMaterial({ emissive: 0x112233, emissiveIntensity: 0.2 });
  const face = new SkinnedMesh(geometry, original);
  face.name = 'Face';
  face.morphTargetInfluences = [0.3];
  const bone = new Bone(); face.add(bone); face.bind(new Skeleton([bone]));
  root.add(face);
  const frame = new ThreeFrameApplier();
  frame.highlightMesh(root, 'Face', 0xd4a040, 0.35);
  const overlay = face.children.find(child => child.isMesh);
  assert.equal(overlay.skeleton, face.skeleton);
  assert.equal(overlay.geometry, geometry);
  // The renderer callback takes the latest morph array and replaced geometry.
  overlay.onBeforeRender();
  assert.equal(overlay.morphTargetInfluences, face.morphTargetInfluences);
  assert.equal(face.material.emissive.getHex(), 0xd4a040);
  frame.highlightMesh(root, null);
  assert.equal(face.material, original);
  assert.equal(original.emissive.getHex(), 0x112233);
  assert.equal(original.emissiveIntensity, 0.2);
  assert.equal(face.children.length, 1, 'clearing keeps the source skeleton');
  geometry.dispose(); original.dispose(); face.skeleton.dispose();
}
