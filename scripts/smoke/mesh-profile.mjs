import assert from 'node:assert/strict';
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, MultiplyBlending, NormalBlending } from 'three';
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
