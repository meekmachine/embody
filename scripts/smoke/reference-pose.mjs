import assert from 'node:assert/strict';
import { Bone, BufferGeometry, Euler, Matrix4, Mesh, Object3D, Quaternion, Vector3 } from 'three';
import { bindModelReferencePose, captureModelReferencePose, extendModelReferencePose, ThreeModelInspector } from '../../dist/three.js';

const near = (actual, expected, message) => {
  assert.equal(actual.length, expected.length, message);
  actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-10, `${message}: ${value} != ${expected[index]}`));
};

const assertFrozenData = (value) => {
  if (value && typeof value === 'object') {
    assert.ok(Object.isFrozen(value));
    assert.ok(Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype);
    Object.values(value).forEach(assertFrozenData);
  } else {
    assert.ok(value === null || ['string', 'number', 'boolean'].includes(typeof value));
    if (typeof value === 'number') assert.ok(Number.isFinite(value));
  }
};

const makeRig = () => {
  const scene = new Object3D();
  scene.name = 'scene';
  scene.position.set(5, 6, 7);
  scene.rotation.z = Math.PI / 2;
  const model = new Object3D();
  model.name = 'model';
  model.position.x = 3;
  const parent = new Object3D();
  parent.name = 'non-bone pivot';
  parent.rotation.y = Math.PI / 3;
  parent.position.set(1, 2, 3);
  const left = new Bone();
  left.name = 'duplicate';
  left.position.set(4, 5, 6);
  left.rotation.x = Math.PI / 4;
  const right = new Bone();
  right.name = 'duplicate';
  right.position.set(-4, 5, 6);
  right.rotation.set(0.1, 0.2, 0.3, 'YXZ');
  parent.add(left, right);
  model.add(parent);
  scene.add(model);
  return { scene, model, parent, left, right };
};

{
  const { scene, model, parent, left, right } = makeRig();
  const all = [scene, model, parent, left, right];
  // Matrices are deliberately stale; capture must compose current local TRS
  // without updating any matrix, matrixWorld, or dirty flag on the input scene.
  const before = all.map((object) => ({
    matrix: object.matrix.toArray(),
    matrixWorld: object.matrixWorld.toArray(),
    dirty: object.matrixWorldNeedsUpdate,
  }));
  for (const object of all) {
    object.updateMatrix = () => { throw new Error('Capture must not update scene matrices'); };
    object.updateMatrixWorld = object.updateMatrix;
    object.updateWorldMatrix = object.updateMatrix;
  }
  const pose = captureModelReferencePose(model);
  const bindings = bindModelReferencePose(model, pose);
  assert.deepEqual(pose.nodes.map((node) => node.path), ['', '/0', '/0/0', '/0/1']);
  assert.deepEqual(pose.nodes.map((node) => node.parentPath), [null, '', '/0', '/0']);
  assert.equal(bindings.get(left).name, bindings.get(right).name);
  assert.notEqual(bindings.get(left).path, bindings.get(right).path);
  assertFrozenData(pose);
  assert.doesNotThrow(() => JSON.stringify(pose));
  assert.throws(() => { bindings.get(left).transform.position.x = 99; }, TypeError);
  assert.throws(() => { bindings.get(left).worldMatrix[0] = 99; }, TypeError);

  const compose = (object) => new Matrix4().compose(object.position, object.quaternion, object.scale);
  const expectedWorld = compose(scene).multiply(compose(model)).multiply(compose(parent)).multiply(compose(left));
  near(bindings.get(left).worldMatrix, expectedWorld.toArray(), 'non-bone ancestors contribute to world matrix');
  near(pose.parentWorldMatrix, compose(scene).toArray(), 'external parent transform is captured');
  const expectedPosition = new Vector3().setFromMatrixPosition(expectedWorld);
  assert.deepEqual(bindings.get(left).worldPosition, { x: expectedPosition.x, y: expectedPosition.y, z: expectedPosition.z });
  all.forEach((object, index) => assert.deepEqual({
    matrix: object.matrix.toArray(),
    matrixWorld: object.matrixWorld.toArray(),
    dirty: object.matrixWorldNeedsUpdate,
  }, before[index]));

  const captured = JSON.stringify(pose);
  left.position.set(90, 91, 92);
  left.rotation.set(1, 2, 3);
  left.rotation.order = 'ZYX';
  right.rotation.set(1, 2, 3, 'ZYX');
  parent.scale.set(3, 4, 5);
  scene.position.set(100, 100, 100);
  const duringPlayback = bindModelReferencePose(model, pose);
  assert.equal(JSON.stringify(pose), captured, 'live animation cannot alter the reference pose');
  assert.equal(duringPlayback.get(left), bindings.get(left));
  const inspection = new ThreeModelInspector().inspectModel(model, { referencePose: pose });
  assert.deepEqual(inspection.descriptor.bones[0].restTransform, bindings.get(left).transform);
  assert.deepEqual(inspection.descriptor.bones[0].worldPosition, bindings.get(left).worldPosition);
  assert.equal(inspection.bones.duplicate.basePos.x, bindings.get(right).transform.position.x);
  assert.equal(inspection.bones.duplicate.baseEuler.order, 'YXZ', 'reference Euler order is independent from live order');
  near(inspection.bones.duplicate.baseQuat.toArray(), Object.values(bindings.get(right).transform.rotation), 'base quaternion is captured, not live');
  inspection.descriptor.bones[0].restTransform.position.x = -123;
  inspection.bones.duplicate.baseQuat.set(0, 0, 0, 1);
  assert.equal(JSON.stringify(pose), captured, 'mutable legacy inspection data must not alias the snapshot');

  const clone = model.clone(true);
  const clonedLeft = clone.children[0].children[0];
  assert.notEqual(clonedLeft.uuid, left.uuid);
  const clonedBindings = bindModelReferencePose(clone, pose);
  assert.equal(clonedBindings.get(clonedLeft), bindings.get(left));
  assert.equal(new ThreeModelInspector().inspectModel(clone, { referencePose: pose }).descriptor.bones[0].restTransform.position.x, 4);
}

{
  const { model } = makeRig();
  const pose = captureModelReferencePose(model);
  const incompatible = (mutate) => {
    const clone = model.clone(true);
    mutate(clone);
    assert.throws(() => bindModelReferencePose(clone, pose), /Incompatible reference pose hierarchy/);
    assert.throws(() => new ThreeModelInspector().inspectModel(clone, { referencePose: pose }), /Incompatible reference pose hierarchy/);
  };
  incompatible((clone) => { clone.children[0].name = 'renamed'; });
  incompatible((clone) => { clone.children[0].type = 'ChangedType'; });
  incompatible((clone) => { clone.children[0].isBone = true; });
  incompatible((clone) => { clone.children[0].remove(clone.children[0].children[1]); });
  incompatible((clone) => { clone.children[0].add(new Bone()); });
  incompatible((clone) => { clone.name = 'different root'; });
  assert.throws(() => bindModelReferencePose(model, { ...pose, version: 2 }), /Unsupported model reference pose version/);
  assert.throws(() => bindModelReferencePose(model, { ...pose, nodes: [...pose.nodes, pose.nodes[0]] }), /extra captured nodes/);
}

{
  const { scene, model, parent, left } = makeRig();
  scene.matrixAutoUpdate = false;
  scene.matrix.makeTranslation(11, 12, 13);
  parent.matrixAutoUpdate = false;
  parent.matrix.set(
    1, 0.4, 0, 7,
    0, 2, 0.2, 8,
    0, 0, 3, 9,
    0, 0, 0, 1,
  );
  parent.position.set(90, 90, 90); // Inactive TRS must not replace a manual matrix.
  const pose = captureModelReferencePose(model);
  const bindings = bindModelReferencePose(model, pose);
  near(bindings.get(parent).localMatrix, parent.matrix.toArray(), 'manual matrix shear is preserved');
  assert.deepEqual(bindings.get(parent).transform.position, { x: 7, y: 8, z: 9 });
  assert(!Object.hasOwn(bindings.get(parent), 'rotationEuler'), 'manual matrix references do not retain inactive Euler values');
  near(pose.parentWorldMatrix, scene.matrix.toArray(), 'manual external ancestor matrix is authoritative');
  const expected = scene.matrix.clone()
    .multiply(new Matrix4().compose(model.position, model.quaternion, model.scale))
    .multiply(parent.matrix)
    .multiply(new Matrix4().compose(left.position, left.quaternion, left.scale));
  near(bindings.get(left).worldMatrix, expected.toArray(), 'world matrix preserves inherited shear');
  const captured = JSON.stringify(pose);
  parent.matrix.identity();
  assert.equal(JSON.stringify(pose), captured);
}

{
  const model = new Object3D();
  model.position.x = NaN;
  assert.throws(() => captureModelReferencePose(model), /non-finite values/);
  model.position.x = 0;
  model.matrixAutoUpdate = false;
  model.matrix.makeScale(0, 1, 1);
  assert.throws(() => captureModelReferencePose(model), /non-finite values/, 'singular manual matrices must not invent a rotation');
}

{
  const { scene, model, parent, left, right } = makeRig();
  left.name = 'Left';
  right.name = 'Right';
  const face = new Mesh(new BufferGeometry());
  face.name = 'Face';
  face.morphTargetDictionary = { Smile: 0, Frown: 1 };
  face.morphTargetInfluences = [0.25, 0.5];
  model.add(face);
  const original = captureModelReferencePose(model);
  const before = JSON.stringify(original);
  const originalBindings = bindModelReferencePose(model, original);
  assert.deepEqual(originalBindings.get(face).morphInfluences, [0.25, 0.5]);
  assert(!Object.hasOwn(originalBindings.get(parent), 'morphInfluences'));
  assert.throws(() => { originalBindings.get(face).morphInfluences[0] = 1; }, TypeError);

  // The old scene placement, model transform, intermediate parent and skeleton
  // have all moved. Appended bones must still use the captured parent frame.
  scene.position.set(100, 200, 300);
  model.rotation.set(0.7, 0.8, 0.9);
  parent.position.set(40, 50, 60);
  parent.scale.set(2, 3, 4);
  left.rotation.set(1, 2, 3);
  face.morphTargetInfluences[0] = 0.9;
  face.morphTargetInfluences[1] = 0.8;
  const skeleton = new Bone();
  skeleton.name = 'AddedSkeleton';
  skeleton.position.set(2, 3, 4);
  skeleton.rotation.z = 0.4;
  const tip = new Bone();
  tip.name = 'AddedTip';
  tip.position.set(0, 5, 0);
  skeleton.add(tip);
  parent.add(skeleton);
  const rootBone = new Bone();
  rootBone.name = 'AddedAtRoot';
  rootBone.position.set(6, 7, 8);
  model.add(rootBone);
  assert.throws(() => bindModelReferencePose(model, original), /Incompatible reference pose hierarchy/, 'ordinary binding remains strict');

  const sceneObjects = [scene, model, parent, left, right, face, skeleton, tip, rootBone];
  const liveState = () => sceneObjects.map((object) => ({
    position: object.position.toArray(), quaternion: object.quaternion.toArray(), scale: object.scale.toArray(),
    matrix: object.matrix.toArray(), worldMatrix: object.matrixWorld.toArray(), dirty: object.matrixWorldNeedsUpdate,
  }));
  const liveBefore = liveState();
  // Also accept persisted plain data without freezing the caller's old copy.
  const previous = JSON.parse(before);
  const extended = extendModelReferencePose(model, previous);
  const bindings = bindModelReferencePose(model, extended);
  assertFrozenData(extended);
  assert.deepEqual(liveState(), liveBefore, 'extension does not update the scene');
  assert.equal(JSON.stringify(previous), before);
  assert(!Object.isFrozen(previous.nodes[0].transform), 'extension does not freeze caller-owned data');
  assert.equal(JSON.stringify(original), before);
  assert.deepEqual(extended.parentWorldMatrix, original.parentWorldMatrix);
  for (const object of [model, parent, left, right, face]) {
    assert.deepEqual(bindings.get(object), { ...originalBindings.get(object), childCount: object.children.length }, 'only child count changes on old nodes');
  }
  const compose = (object) => new Matrix4().compose(object.position, object.quaternion, object.scale);
  const skeletonWorld = new Matrix4().fromArray(originalBindings.get(parent).worldMatrix).multiply(compose(skeleton));
  near(bindings.get(skeleton).worldMatrix, skeletonWorld.toArray(), 'appended skeleton uses captured parent frame');
  near(bindings.get(tip).worldMatrix, skeletonWorld.clone().multiply(compose(tip)).toArray(), 'appended descendants retain local hierarchy');
  const rootWorld = new Matrix4().fromArray(originalBindings.get(model).worldMatrix).multiply(compose(rootBone));
  near(bindings.get(rootBone).worldMatrix, rootWorld.toArray(), 'appended root child ignores later model placement');
  assert.deepEqual(bindings.get(face).morphInfluences, [0.25, 0.5], 'extension does not sample posed morphs');
  const inspection = new ThreeModelInspector().inspectModel(model, { referencePose: extended });
  assert.equal(inspection.descriptor.morphTargets[0].initialValue, 0.9, 'inspection retains live morph semantics');
  assert.deepEqual(inspection.bones.AddedSkeleton.basePos, { x: 2, y: 3, z: 4 });

  const clone = model.clone(true);
  const cloneBindings = bindModelReferencePose(clone, extended);
  assert.notEqual(clone.children[0].children[2].uuid, skeleton.uuid);
  assert.deepEqual(cloneBindings.get(clone.children[0].children[2]), bindings.get(skeleton));
  assert.deepEqual(extendModelReferencePose(clone, extended), extended, 'a no-op extension preserves the full snapshot');
  face.morphTargetInfluences.push(1);
  assert.deepEqual(bindings.get(face).morphInfluences, [0.25, 0.5], 'morph array shape does not alias live input');
  face.geometry.dispose();
  face.material.dispose();
}

{
  const { model, left, right } = makeRig();
  left.name = 'Left';
  right.name = 'Right';
  const pose = captureModelReferencePose(model);
  const incompatible = (mutate) => {
    const clone = model.clone(true);
    mutate(clone);
    assert.throws(() => extendModelReferencePose(clone, pose), /Incompatible reference pose hierarchy/);
  };
  incompatible((clone) => { clone.children[0].remove(clone.children[0].children[0]); });
  incompatible((clone) => { clone.children[0].children.reverse(); });
  incompatible((clone) => { clone.children[0].children[0].name = 'Renamed'; });
  incompatible((clone) => { clone.children[0].type = 'ChangedType'; });
  incompatible((clone) => { clone.children[0].isBone = true; });
  incompatible((clone) => { clone.name = 'AnotherModel'; });
  incompatible((clone) => {
    const insertion = new Bone();
    insertion.name = 'InsertedBeforeExisting';
    clone.children[0].add(insertion);
    clone.children[0].children.unshift(clone.children[0].children.pop());
  });
  assert.throws(() => extendModelReferencePose(model, { ...pose, version: 2 }), /Unsupported model reference pose version/);
  assert.throws(() => extendModelReferencePose(model, { ...pose, nodes: [...pose.nodes, pose.nodes[0]] }), /extra captured nodes/);

  const appended = new Object3D();
  appended.name = 'InvalidAppend';
  appended.position.x = Infinity;
  model.add(appended);
  assert.throws(() => extendModelReferencePose(model, pose), /non-finite values/);
  appended.position.x = 0;
  appended.morphTargetInfluences = [NaN];
  assert.throws(() => extendModelReferencePose(model, pose), /morph influences.*non-finite values/);
  appended.morphTargetInfluences = [Infinity];
  assert.throws(() => captureModelReferencePose(model), /morph influences.*non-finite values/);
  appended.morphTargetInfluences = [];
  const valid = extendModelReferencePose(model, pose);
  assert.deepEqual(bindModelReferencePose(model, valid).get(appended).morphInfluences, [], 'empty influence arrays stay explicit');
}

{
  const model = new Object3D();
  const bone = new Bone();
  bone.name = 'MultiTurn';
  const authored = { x: 2 * Math.PI + 0.2, y: -2 * Math.PI + 0.3, z: 4 * Math.PI + 0.4 };
  bone.rotation.set(authored.x, authored.y, authored.z, 'ZYX');
  model.add(bone);
  const original = captureModelReferencePose(model);
  const node = bindModelReferencePose(model, original).get(bone);
  assert.deepEqual(node.rotationEuler, authored, 'capture preserves raw authored Euler turns');
  assert.throws(() => { node.rotationEuler.x = 0; }, TypeError);
  bone.rotation.set(0, 0, 0, 'XYZ');
  const inspector = new ThreeModelInspector();
  assert.deepEqual(inspector.inspectModel(model, { referencePose: original }).bones.MultiTurn.baseEuler,
    { ...authored, order: 'ZYX' }, 'inspection preserves authored Euler turns and order after playback');

  const appended = new Bone();
  appended.name = 'AppendedMultiTurn';
  appended.rotation.set(authored.x, authored.y, authored.z, 'YXZ');
  bone.add(appended);
  const extended = extendModelReferencePose(model, original);
  assert.deepEqual(bindModelReferencePose(model, extended).get(bone).rotationEuler, authored);
  assert.deepEqual(bindModelReferencePose(model, extended).get(appended).rotationEuler, authored);
  assertFrozenData(extended);

  // Older snapshots lack raw Euler data; their quaternion fallback remains valid.
  const legacy = { ...extended, nodes: extended.nodes.map(({ rotationEuler, ...rest }) => rest) };
  const { rotation } = node.transform;
  const canonical = new Euler().setFromQuaternion(new Quaternion(rotation.x, rotation.y, rotation.z, rotation.w), 'ZYX');
  const legacyEuler = inspector.inspectModel(model, { referencePose: legacy }).bones.MultiTurn.baseEuler;
  near([legacyEuler.x, legacyEuler.y, legacyEuler.z], [canonical.x, canonical.y, canonical.z], 'legacy Euler fallback');
  assert.equal(legacyEuler.order, 'ZYX');

  const manual = new Bone();
  manual.name = 'Manual';
  manual.matrixAutoUpdate = false;
  manual.matrix.makeRotationY(0.7);
  manual.rotation.set(authored.x, authored.y, authored.z, 'YXZ');
  const manualReference = captureModelReferencePose(manual);
  const manualInspection = inspector.inspectModel(manual, { referencePose: manualReference });
  assert(!Object.hasOwn(manualReference.nodes[0], 'rotationEuler'));
  near([manualInspection.bones.Manual.baseEuler.x, manualInspection.bones.Manual.baseEuler.y, manualInspection.bones.Manual.baseEuler.z],
    [0, 0.7, 0], 'manual matrix references use matrix-derived Euler fallback');
}

console.log('Reference pose smoke passed');
