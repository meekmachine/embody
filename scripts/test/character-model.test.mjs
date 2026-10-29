import assert from 'node:assert/strict';
import test from 'node:test';
import { AnimationClip, BufferGeometry, Float32BufferAttribute, Group, Mesh, MeshBasicMaterial } from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { disposeCharacterModel, loadCharacterModel, parseCharacterModel } from '../../dist/three.js';

const bytes = text => new TextEncoder().encode(text).buffer;
function character() {
  const model = new Group();
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute([0, 0, 0], 3));
  geometry.morphAttributes.position = [new Float32BufferAttribute([0, 1, 0], 3)];
  const face = new Mesh(geometry, new MeshBasicMaterial());
  face.name = 'Face';
  model.add(face);
  model.animations = [new AnimationClip('idle', 1, [])];
  return { model, face };
}

test('FBX URLs, fragments and extensionless uploads share mesh and animation preparation', async t => {
  const fixture = character();
  t.after(() => disposeCharacterModel(null, fixture.model));
  t.mock.method(FBXLoader.prototype, 'load', (url, done, progress) => {
    progress({ lengthComputable: true, loaded: 1, total: 2 });
    done(fixture.model);
  });
  for (const url of ['avatar.fbx', 'avatar.FBX?token=1', 'avatar.fbx#model', 'blob:upload']) {
    const updates = [];
    const result = await loadCharacterModel(url, {
      ...(url.startsWith('blob:') ? { format: 'fbx' } : {}),
      onProgress: value => updates.push(value),
    });
    assert.equal(result.model, fixture.model);
    assert.deepEqual(result.meshes, [fixture.face]);
    assert.equal(fixture.face.castShadow, true);
    assert.equal(result.animations, fixture.model.animations);
    assert.equal(result.gltf, null);
    assert.deepEqual(updates, [50]);
  }
});

test('binary and ASCII FBX buffers forward texture paths and preserve opt-out shadows', async t => {
  const fixture = character();
  t.after(() => disposeCharacterModel(null, fixture.model));
  const parse = t.mock.method(FBXLoader.prototype, 'parse', () => fixture.model);
  for (const header of ['Kaydara FBX Binary  \0', '; FBX 7.4.0 project file\nFBXHeaderExtension: {\n']) {
    const data = bytes(header);
    const result = await parseCharacterModel(data, '/textures/', { castShadows: false });
    assert.deepEqual(parse.mock.calls.at(-1).arguments, [data, '/textures/']);
    assert.equal(result.gltf, null);
    assert.deepEqual(result.meshes, [fixture.face]);
    assert.equal(fixture.face.castShadow, false);
    assert.equal(result.animations, fixture.model.animations);
  }
  const unusualHeader = bytes(';'.repeat(5000));
  await parseCharacterModel(unusualHeader, '/explicit/', { format: 'fbx' });
  assert.deepEqual(parse.mock.calls.at(-1).arguments, [unusualHeader, '/explicit/']);
});

test('explicit format overrides the URL and buffer inference in both directions', async t => {
  const fixture = character();
  t.after(() => disposeCharacterModel(null, fixture.model));
  const gltf = { scene: fixture.model, animations: fixture.model.animations };
  t.mock.method(GLTFLoader.prototype, 'load', (url, done) => done(gltf));
  t.mock.method(GLTFLoader.prototype, 'parse', (data, path, done) => done(gltf));
  assert.equal((await loadCharacterModel('avatar.fbx', { format: 'gltf' })).gltf, gltf);
  assert.equal((await parseCharacterModel(bytes('Kaydara FBX Binary  \0'), '', { format: 'gltf' })).gltf, gltf);
});

test('FBX parsing errors reject the Promise without returning a partial character', async t => {
  const error = new Error('Invalid FBX');
  t.mock.method(FBXLoader.prototype, 'parse', () => { throw error; });
  let pending;
  assert.doesNotThrow(() => { pending = parseCharacterModel(new ArrayBuffer(0), '', { format: 'fbx' }); });
  await assert.rejects(pending, value => value === error);
});

test('real glTF JSON and GLB buffers retain their glTF result', async t => {
  const json = JSON.stringify({ asset: { version: '2.0' }, scenes: [{ nodes: [] }], scene: 0 });
  const padded = bytes(json.padEnd(Math.ceil(json.length / 4) * 4, ' '));
  const glb = new ArrayBuffer(20 + padded.byteLength);
  const view = new DataView(glb);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, glb.byteLength, true);
  view.setUint32(12, padded.byteLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(glb, 20).set(new Uint8Array(padded));
  for (const data of [bytes(json), glb]) {
    const result = await parseCharacterModel(data);
    t.after(() => disposeCharacterModel(null, result.model));
    assert.ok(result.gltf);
    assert.deepEqual(result.animations, []);
  }
});

// Hand-authored FBX 7.4 ASCII fixture: one named root and one child bone.
// No DCC export or proprietary model asset is required for parser coverage.
const asciiFbx = `; FBX 7.4.0 project file
FBXHeaderExtension: {
\tFBXHeaderVersion: 1003
\tFBXVersion: 7400
}
Objects: {
\tModel: 1, "Model::Avatar", "Null" {
\t\tVersion: 232
\t}
\tModel: 2, "Model::Head", "LimbNode" {
\t\tVersion: 232
\t}
}
Connections: {
\tC: "OO",1,0
\tC: "OO",2,1
}
`;

test('real ASCII FBX parsing retains named bones for the shared character inspector', async t => {
  const result = await parseCharacterModel(bytes(asciiFbx));
  t.after(() => disposeCharacterModel(null, result.model));
  assert.equal(result.gltf, null);
  assert.equal(result.model.name, 'Avatar');
  assert.equal(result.model.getObjectByName('Head').isBone, true);
  assert.deepEqual(result.animations, []);
});

test('unsupported ASCII FBX versions reject through the real loader', async () => {
  await assert.rejects(parseCharacterModel(bytes(asciiFbx.replace('7400', '6100'))), /FBX version not supported/);
});
