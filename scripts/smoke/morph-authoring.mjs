import assert from 'node:assert/strict';
import {
  BufferAttribute,
  BufferGeometry,
  Mesh,
  MeshBasicMaterial,
  Object3D,
} from 'three';
import { ThreeFrameApplier } from '../../dist/three.js';

const makeMesh = (name, { absolute = false, existing = false } = {}) => {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([
    10, 0, 0,
    10, 1, 0,
    10, 0, 1,
  ]), 3));
  geometry.morphTargetsRelative = !absolute;

  const mesh = new Mesh(geometry, new MeshBasicMaterial());
  mesh.name = name;
  if (existing) {
    geometry.morphAttributes.position = [new BufferAttribute(new Float32Array([
      absolute ? 11 : 1, 0, 0,
      absolute ? 11 : 1, 1, 0,
      absolute ? 11 : 1, 0, 1,
    ]), 3)];
    mesh.morphTargetDictionary = { Existing: 0 };
    mesh.morphTargetInfluences = [0];
  }
  return mesh;
};

const delta = new Float32Array([
  1, 0, 0,
  1, 0, 0,
  1, 0, 0,
]);

{
  const root = new Object3D();
  const mesh = makeMesh('AbsoluteFace', { absolute: true, existing: true });
  const sourceGeometry = mesh.geometry;
  let disposeCount = 0;
  sourceGeometry.addEventListener('dispose', () => { disposeCount += 1; });
  root.add(mesh);

  assert.throws(
    () => new ThreeFrameApplier().addMorphTarget(root, {
      meshName: mesh.name,
      name: 'RelativeOnAbsolute',
      relative: true,
      position: delta,
    }),
    /existing morph targets are absolute/,
  );
  assert.equal(mesh.geometry, sourceGeometry);
  assert.equal(mesh.geometry.morphTargetsRelative, false);
  assert.equal(mesh.geometry.morphAttributes.position[0].getX(0), 11);
  assert.equal(disposeCount, 0);
}

{
  const root = new Object3D();
  const mesh = makeMesh('ReplacementFace', { existing: true });
  const sourceGeometry = mesh.geometry;
  let disposeCount = 0;
  sourceGeometry.addEventListener('dispose', () => { disposeCount += 1; });
  root.add(mesh);

  const index = new ThreeFrameApplier().addMorphTarget(root, {
    meshName: mesh.name,
    name: 'Added',
    relative: true,
    position: delta,
  });
  assert.equal(index, 1);
  assert.notEqual(mesh.geometry, sourceGeometry);
  assert.equal(disposeCount, 1);
}

{
  const root = new Object3D();
  const mesh = makeMesh('AtomicFace');
  const sourceGeometry = mesh.geometry;
  let disposeCount = 0;
  sourceGeometry.addEventListener('dispose', () => { disposeCount += 1; });
  root.add(mesh);

  assert.throws(
    () => new ThreeFrameApplier().addMorphTargets(root, [
      { meshName: mesh.name, name: 'Good', relative: true, position: delta },
      { meshName: mesh.name, name: 'Bad', relative: true, position: new Float32Array([1, 2, 3]) },
    ]),
    /Invalid position morph data length/,
  );
  assert.equal(mesh.geometry, sourceGeometry);
  assert.equal(mesh.geometry.morphAttributes.position, undefined);
  assert.equal(mesh.morphTargetDictionary, undefined);
  assert.equal(mesh.morphTargetInfluences, undefined);
  assert.equal(disposeCount, 0);
}

{
  const root = new Object3D();
  const mesh = makeMesh('BatchFace');
  const sourceGeometry = mesh.geometry;
  let disposeCount = 0;
  sourceGeometry.addEventListener('dispose', () => { disposeCount += 1; });
  root.add(mesh);

  const result = new ThreeFrameApplier().addMorphTargets(root, [
    { meshName: mesh.name, name: 'First', relative: true, position: delta },
    { meshName: mesh.name, name: 'Second', relative: true, position: delta },
  ]);
  assert.deepEqual(result, { 'BatchFace:First': 0, 'BatchFace:Second': 1 });
  assert.equal(mesh.geometry.morphAttributes.position.length, 2);
  assert.deepEqual(mesh.morphTargetInfluences, [0, 0]);
  assert.equal(disposeCount, 1);
}

console.log('Morph authoring smoke passed');
