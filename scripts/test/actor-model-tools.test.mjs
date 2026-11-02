import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { Document, WebIO } from '@gltf-transform/core';
import { extractGarmentModel, inspectActorModel, prepareActorModel } from '@lovelace_lol/embody/model-tools';

const execute = promisify(execFile);
const io = new WebIO();

async function fixture({ rigged = false, sharedScenes = false } = {}) {
  const document = new Document();
  const buffer = document.createBuffer();
  const accessor = (type, values) => document.createAccessor().setBuffer(buffer).setType(type).setArray(values);
  const side = 12;
  const positions = [];
  const indices = [];
  for (let y = 0; y <= side; y++) for (let x = 0; x <= side; x++) positions.push(x / side, y / side, 0);
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
    const vertex = y * (side + 1) + x;
    indices.push(vertex, vertex + 1, vertex + side + 1, vertex + 1, vertex + side + 2, vertex + side + 1);
  }
  const primitive = document.createPrimitive().setAttribute('POSITION', accessor('VEC3', new Float32Array(positions)))
    .setIndices(accessor('SCALAR', new Uint16Array(indices)));
  const body = document.createMesh('Body').addPrimitive(primitive);
  const bodyNode = document.createNode('BodyNode').setMesh(body);
  const garment = document.createMesh('Coat').addPrimitive(document.createPrimitive()
    .setAttribute('POSITION', accessor('VEC3', new Float32Array([0, 0, 1, 1, 0, 1, 0, 1, 1])))
    .setMaterial(document.createMaterial('Blue coat').setBaseColorFactor([0, 0, 1, 1])));
  const garmentNode = document.createNode('CoatNode').setMesh(garment);
  const scene = document.createScene('Scene').addChild(bodyNode).addChild(garmentNode);
  if (rigged) {
    const count = positions.length / 3;
    const joints = new Uint16Array(count * 4);
    const weights = new Float32Array(count * 4);
    for (let vertex = 0; vertex < count; vertex++) weights[vertex * 4] = 1;
    primitive.setAttribute('JOINTS_0', accessor('VEC4', joints)).setAttribute('WEIGHTS_0', accessor('VEC4', weights));
    const morph = new Float32Array(positions.length);
    morph[(6 * (side + 1) + 6) * 3 + 2] = 0.25;
    primitive.addTarget(document.createPrimitiveTarget('Smile').setAttribute('POSITION', accessor('VEC3', morph)));
    body.setExtras({ targetNames: ['Smile'], mappingTag: 'stable-body' }).setWeights([0]);
    const joint = document.createNode('Head');
    scene.addChild(joint);
    const bind = accessor('MAT4', new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]));
    bodyNode.setSkin(document.createSkin('Rig').addJoint(joint).setSkeleton(joint).setInverseBindMatrices(bind));
    const animation = document.createAnimation('Expression');
    const sampler = document.createAnimationSampler().setInput(accessor('SCALAR', new Float32Array([0, 1])))
      .setOutput(accessor('SCALAR', new Float32Array([0, 1]))).setInterpolation('LINEAR');
    animation.addSampler(sampler).addChannel(document.createAnimationChannel().setTargetNode(bodyNode).setTargetPath('weights').setSampler(sampler));
  }
  if (sharedScenes) document.createScene('Body only').addChild(bodyNode);
  return io.writeBinary(document);
}

test('inspection identifies explicit mesh selectors, materials, dimensions and rig state', async () => {
  const source = await fixture({ rigged: true });
  const result = await inspectActorModel(source);
  assert.equal(result.byteLength, source.byteLength);
  assert.equal(result.canTransform, true);
  assert.equal(result.animationCount, 1);
  assert.equal(result.skinCount, 1);
  assert.equal(result.meshes[0].id, 'mesh:0');
  assert.equal(result.meshes[0].name, 'Body');
  assert.deepEqual(result.meshes[0].nodeNames, ['BodyNode']);
  assert.equal(result.meshes[0].triangleCount, 288);
  assert.equal(result.meshes[0].skinned, true);
  assert.equal(result.meshes[0].morphTargetCount, 1);
  assert.deepEqual(result.meshes[1].materials, ['Blue coat']);
});

test('original copies bytes and owns its output without mutating caller storage', async () => {
  const source = await fixture();
  const original = source.slice();
  const result = await prepareActorModel(source, { kind: 'original' });
  assert.deepEqual(result.bytes, original);
  assert.notEqual(result.bytes.buffer, source.buffer);
  result.bytes[0] = 0;
  assert.deepEqual(source, original);
});

test('outfit removal changes only selected mesh geometry and preserves named rig and clips', async () => {
  const source = await fixture({ rigged: true });
  const saved = source.slice();
  const result = await prepareActorModel(source, { kind: 'outfit', removeMeshIds: ['mesh:1'] });
  const document = await io.readBinary(result.bytes);
  const root = document.getRoot();
  assert.deepEqual(result.removedMeshIds, ['mesh:1']);
  assert.deepEqual(root.listMeshes().map((mesh) => mesh.getName()), ['Body']);
  assert.deepEqual(root.listNodes().map((node) => node.getName()), ['BodyNode', 'CoatNode', 'Head']);
  assert.equal(root.listNodes().find((node) => node.getName() === 'CoatNode').getMesh(), null);
  assert.deepEqual(root.listSkins()[0].listJoints().map((node) => node.getName()), ['Head']);
  assert.equal(root.listAnimations()[0].getName(), 'Expression');
  assert.equal(root.listAnimations()[0].listChannels()[0].getTargetNode().getName(), 'BodyNode');
  assert.deepEqual([...root.listAnimations()[0].listSamplers()[0].getOutput().getArray()], [0, 1]);
  assert.deepEqual(root.listMeshes()[0].getExtras().targetNames, ['Smile']);
  assert.deepEqual(source, saved);
});

test('low-resolution makes a smaller grid and remaps skin and morph streams together', async () => {
  const source = await fixture({ rigged: true });
  const sourceDocument = await io.readBinary(source);
  const original = source.slice();
  const result = await prepareActorModel(source, { kind: 'low-resolution', targetRatio: 0.5, maxError: 0.001 });
  assert.ok(result.after.triangleCount < result.before.triangleCount);
  assert.ok(result.after.byteLength < result.before.byteLength);
  const document = await io.readBinary(result.bytes);
  const mesh = document.getRoot().listMeshes()[0];
  const primitive = mesh.listPrimitives()[0];
  const sourcePrimitive = sourceDocument.getRoot().listMeshes()[0].listPrimitives()[0];
  const count = primitive.getAttribute('POSITION').getCount();
  assert.equal(primitive.getAttribute('JOINTS_0').getCount(), count);
  assert.equal(primitive.getAttribute('WEIGHTS_0').getCount(), count);
  assert.equal(primitive.listTargets()[0].getAttribute('POSITION').getCount(), count);
  const sourcePositions = sourcePrimitive.getAttribute('POSITION').getArray();
  const positions = primitive.getAttribute('POSITION').getArray();
  const sourceVertices = new Map();
  for (let vertex = 0; vertex < sourcePositions.length / 3; vertex++) {
    sourceVertices.set(sourcePositions.subarray(vertex * 3, vertex * 3 + 3).join(','), vertex);
  }
  const retainedPositions = new Set();
  const streams = [
    [sourcePrimitive.getAttribute('JOINTS_0'), primitive.getAttribute('JOINTS_0')],
    [sourcePrimitive.getAttribute('WEIGHTS_0'), primitive.getAttribute('WEIGHTS_0')],
    [sourcePrimitive.listTargets()[0].getAttribute('POSITION'), primitive.listTargets()[0].getAttribute('POSITION')],
  ];
  for (let vertex = 0; vertex < count; vertex++) {
    const key = positions.subarray(vertex * 3, vertex * 3 + 3).join(',');
    const sourceVertex = sourceVertices.get(key);
    assert.notEqual(sourceVertex, undefined, 'simplification retains original vertex positions');
    retainedPositions.add(key);
    for (const [before, after] of streams) {
      const size = before.getElementSize();
      assert.deepEqual(after.getArray().subarray(vertex * size, (vertex + 1) * size),
        before.getArray().subarray(sourceVertex * size, (sourceVertex + 1) * size));
    }
  }
  for (let vertex = 0; vertex < sourcePositions.length / 3; vertex++) {
    const point = sourcePositions.subarray(vertex * 3, vertex * 3 + 3);
    if (point[0] === 0 || point[0] === 1 || point[1] === 0 || point[1] === 1 || (point[0] === 0.5 && point[1] === 0.5)) {
      assert.ok(retainedPositions.has(point.join(',')), 'border and morph-active vertices remain present');
    }
  }
  assert.deepEqual(mesh.getExtras(), sourceDocument.getRoot().listMeshes()[0].getExtras());
  assert.deepEqual(mesh.getWeights(), [0]);
  assert.deepEqual(document.getRoot().listSkins()[0].listJoints().map((node) => node.getName()), ['Head']);
  assert.deepEqual([...document.getRoot().listSkins()[0].getInverseBindMatrices().getArray()],
    [...sourceDocument.getRoot().listSkins()[0].getInverseBindMatrices().getArray()]);
  assert.equal(document.getRoot().listAnimations()[0].listChannels()[0].getTargetNode().getName(), 'BodyNode');
  assert.deepEqual([...document.getRoot().listAnimations()[0].listSamplers()[0].getOutput().getArray()], [0, 1]);
  assert.deepEqual(source, original);
});

test('low-resolution reports a limit instead of discarding fully morph-active geometry', async () => {
  const document = await io.readBinary(await fixture({ rigged: true }));
  const primitive = document.getRoot().listMeshes()[0].listPrimitives()[0];
  const morph = primitive.listTargets()[0].getAttribute('POSITION');
  const deltas = new Float32Array(morph.getArray().length);
  for (let vertex = 0; vertex < morph.getCount(); vertex++) deltas[vertex * 3 + 2] = 0.25;
  morph.setArray(deltas);
  const source = await io.writeBinary(document);
  const result = await prepareActorModel(source, { kind: 'low-resolution', targetRatio: 0.5, maxError: 0.001 });
  assert.equal(result.after.triangleCount, result.before.triangleCount);
  assert.equal(result.after.vertexCount, result.before.vertexCount);
  assert.ok(result.warnings.some((warning) => warning.includes('retained more triangles')));
  const output = await io.readBinary(result.bytes);
  const target = output.getRoot().listMeshes()[0].listPrimitives()[0].listTargets()[0];
  assert.deepEqual(target.getAttribute('POSITION').getArray(), deltas);
});

test('bust uses explicit mesh inclusion and never infers body parts from names', async () => {
  const source = await fixture();
  await assert.rejects(prepareActorModel(source, { kind: 'bust' }), /explicit meshes/);
  const result = await prepareActorModel(source, { kind: 'bust', keepMeshIds: ['mesh:0'] });
  assert.deepEqual(result.after.meshes.map((mesh) => mesh.name), ['Body']);
});

test('miniature scale retains shared scene roots, bind matrices, animation samples and names', async () => {
  const source = await fixture({ rigged: true, sharedScenes: true });
  await assert.rejects(prepareActorModel(source, { kind: 'miniature' }), /scale/);
  const result = await prepareActorModel(source, { kind: 'miniature', scale: 0.25 });
  const document = await io.readBinary(result.bytes);
  const root = document.getRoot();
  assert.equal(root.listScenes()[1].listChildren().length, 1);
  const bodyWrapper = root.listScenes()[1].listChildren()[0];
  assert.deepEqual(bodyWrapper.getScale(), [0.25, 0.25, 0.25]);
  assert.equal(bodyWrapper.listChildren()[0].getName(), 'BodyNode');
  assert.ok(root.listScenes()[0].listChildren().includes(bodyWrapper));
  assert.equal(root.listScenes()[0].listChildren().length, 3);
  assert.equal(root.listAnimations()[0].listChannels()[0].getTargetNode().getName(), 'BodyNode');
  assert.deepEqual([...root.listAnimations()[0].listSamplers()[0].getOutput().getArray()], [0, 1]);
});

test('invalid selectors and reduction limits fail before producing output', async () => {
  const source = await fixture();
  for (const options of [
    { kind: 'optimized', removeMeshIds: ['Coat'] },
    { kind: 'optimized', removeMeshIds: ['mesh:1', 'mesh:1'] },
    { kind: 'optimized', removeMeshIds: ['mesh:0', 'mesh:1'] },
    { kind: 'optimized', keepMeshIds: ['mesh:0'], removeMeshIds: ['mesh:1'] },
    { kind: 'low-resolution', targetRatio: 0 },
    { kind: 'low-resolution', targetRatio: NaN },
    { kind: 'low-resolution', maxError: 1 },
    { kind: 'optimized', scale: 0.5 },
    { kind: 'miniature', scale: -1 },
    { kind: 'original', targetRatio: 0.5 },
  ]) await assert.rejects(prepareActorModel(source, options));
});

test('extensions and URIs are identified and cannot be silently discarded', async () => {
  const source = await fixture();
  const jsonDoc = await io.binaryToJSON(source);
  // Replace only the JSON chunk while retaining original embedded resources.
  const withJSON = (json) => {
    const oldLength = new DataView(source.buffer, source.byteOffset).getUint32(12, true);
    const text = new TextEncoder().encode(JSON.stringify(json));
    const padded = Math.ceil(text.byteLength / 4) * 4;
    const binaryChunk = source.subarray(20 + oldLength);
    const bytes = new Uint8Array(20 + padded + binaryChunk.byteLength);
    const view = new DataView(bytes.buffer);
    [0x46546c67, 2, bytes.byteLength, padded, 0x4e4f534a].forEach((value, index) => view.setUint32(index * 4, value, true));
    bytes.fill(32, 20, 20 + padded); bytes.set(text, 20); bytes.set(binaryChunk, 20 + padded);
    return bytes;
  };
  for (const json of [
    { ...jsonDoc.json, extensionsUsed: ['VRMC_vrm'], extensions: { VRMC_vrm: {} } },
    { ...jsonDoc.json, buffers: [{ ...jsonDoc.json.buffers[0], uri: 'model.bin' }] },
  ]) {
    const unsupported = withJSON(json);
    assert.equal((await inspectActorModel(unsupported)).canTransform, false);
    await assert.rejects(prepareActorModel(unsupported, { kind: 'optimized' }), /Processing requires/);
    assert.deepEqual((await prepareActorModel(unsupported, { kind: 'original' })).bytes, unsupported);
  }
});

test('cancellation rejects before work and between asynchronous processing stages', async () => {
  const source = await fixture();
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(inspectActorModel(source, { signal: cancelled.signal }), { name: 'AbortError' });
  await assert.rejects(prepareActorModel(source, { kind: 'optimized', signal: cancelled.signal }), { name: 'AbortError' });
  const pending = new AbortController();
  const result = prepareActorModel(source, { kind: 'low-resolution', signal: pending.signal });
  pending.abort();
  await assert.rejects(result, { name: 'AbortError' });
});

test('GLB length and chunk bounds reject truncated data before processing', async () => {
  const source = await fixture();
  await assert.rejects(inspectActorModel(source.subarray(0, source.length - 1)), /header or length/);
  const malformed = source.slice();
  new DataView(malformed.buffer).setUint32(12, source.length, true);
  await assert.rejects(prepareActorModel(malformed, { kind: 'optimized' }), /chunk length/);
  const storage = new Uint8Array(source.length + 1);
  storage.set(source, 1);
  assert.equal((await inspectActorModel(storage.subarray(1))).triangleCount, 289);
});

test('CLI creates a separate GLB and refuses existing outputs and source aliases', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'embody-actor-'));
  try {
    const source = await fixture();
    const input = join(directory, 'source.glb');
    const output = join(directory, 'variant.glb');
    await writeFile(input, source);
    const script = new URL('../../model-tools/prepare-actor.mjs', import.meta.url).pathname;
    const args = [script, '--input', input, '--output', output, '--kind', 'outfit', '--remove-mesh', 'mesh:1'];
    const { stdout } = await execute(process.execPath, args);
    assert.equal(JSON.parse(stdout).after.meshes.length, 1);
    await assert.rejects(execute(process.execPath, args), /EEXIST/);
    await assert.rejects(execute(process.execPath, [script, '--input', input, '--output', input, '--kind', 'original']), /differ from the source/);
    assert.deepEqual(new Uint8Array(await readFile(input)), source);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// Raw fixtures retain bufferView/sampler/extension extras that a document rewrite can discard.
function garmentGlb(json, binary) {
  const text = new TextEncoder().encode(JSON.stringify(json));
  const length = Math.ceil(text.length / 4) * 4;
  const binLength = Math.ceil(binary.length / 4) * 4;
  const bytes = new Uint8Array(28 + length + binLength);
  const view = new DataView(bytes.buffer);
  [0x46546c67, 2, bytes.length, length, 0x4e4f534a].forEach((value, index) => view.setUint32(index * 4, value, true));
  bytes.fill(32, 20, 20 + length);
  bytes.set(text, 20);
  view.setUint32(20 + length, binLength, true);
  view.setUint32(24 + length, 0x004e4942, true);
  bytes.set(binary, 28 + length);
  return bytes;
}

function garmentJson(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(12, true);
  return {
    json: JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + length))),
    binary: bytes.subarray(28 + length),
  };
}

function garmentFixture() {
  const chunks = [];
  const views = [];
  let length = 0;
  function append(array, properties = {}) {
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    const index = views.push({ buffer: 0, byteOffset: length, byteLength: bytes.length, ...properties }) - 1;
    chunks.push({ start: length, bytes });
    length += Math.ceil(bytes.length / 4) * 4;
    return index;
  }
  // Clothing and body attributes share one interleaved view. Only the clothing elements may escape.
  const interleaved = new Float32Array([0, 0, 1, 911, 912, 913, 1, 0, 1, 921, 922, 923,
    0, 1, 1, 931, 932, 933, 7, 8, 9, 941, 942, 943]);
  const positionView = append(interleaved, { byteStride: 24, target: 34962, extras: { sourceStream: 'shared' } });
  const jointView = append(new Uint16Array([2, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0]));
  const bodyJointView = append(new Uint16Array(16));
  const weightView = append(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]));
  const morphView = append(new Float32Array([0, 0, 0, 0, 0, 0.25, 0, 0, 0, 0, 0, 0]));
  const indexView = append(new Uint16Array([2, 0, 1]), { target: 34963 });
  const uvView = append(new Float32Array([0, 0, 1, 0, 0, 1, 0.5, 0.5]));
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const bindView = append(new Float32Array([...identity, ...identity, ...identity]));
  const image = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64'));
  const bodyImage = append(new Uint8Array([...image, ...new TextEncoder().encode('BODY_IMAGE_ONLY')]));
  const garmentImage = append(image, { extras: { encodedImage: true } });
  const json = {
    asset: { version: '2.0', extras: { creator: 'fixture' } }, extras: { character: 'donor', opaqueIndex: 999 },
    extensionsUsed: ['KHR_texture_transform', 'KHR_materials_specular', 'EXT_materials_bump'],
    buffers: [{ byteLength: length, extras: { source: 'original' } }], bufferViews: views,
    accessors: [
      { bufferView: positionView, componentType: 5126, type: 'VEC3', count: 4, min: [0, 0, 1], max: [7, 8, 9], extras: { vertexIdentity: 'authored' } },
      { bufferView: positionView, byteOffset: 12, componentType: 5126, type: 'VEC3', count: 4 },
      { bufferView: jointView, componentType: 5123, type: 'VEC4', count: 4 },
      { bufferView: weightView, componentType: 5126, type: 'VEC4', count: 4 },
      { bufferView: morphView, componentType: 5126, type: 'VEC3', count: 4, extras: { expression: 'Flutter' } },
      { bufferView: indexView, componentType: 5123, type: 'SCALAR', count: 3 },
      { bufferView: uvView, componentType: 5126, type: 'VEC2', count: 4 },
      { bufferView: bindView, componentType: 5126, type: 'MAT4', count: 3 },
      { bufferView: bodyJointView, componentType: 5123, type: 'VEC4', count: 4 },
    ],
    images: [{ name: 'BodyImage', bufferView: bodyImage, mimeType: 'image/png' },
      { name: 'ClothImage', bufferView: garmentImage, mimeType: 'image/png', extras: { imageTag: 'keep' } }],
    samplers: [{ wrapS: 33071, wrapT: 33648, magFilter: 9728, extras: { samplerTag: 'keep' } }],
    textures: [{ source: 0 }, { source: 1, sampler: 0, extras: { textureTag: 'keep' } }],
    materials: [{ name: 'Body', pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }, {
      name: 'Cloth', extras: { materialTag: 'keep' },
      pbrMetallicRoughness: { baseColorTexture: { index: 1, texCoord: 0, extras: { textureInfoTag: 'keep' },
        extensions: { KHR_texture_transform: { offset: [0.25, 0.5], scale: [2, 3], rotation: 0.2, extras: { transformTag: 'keep' } } } } },
      extensions: { KHR_materials_specular: { specularFactor: 0.3, specularTexture: { index: 1 } },
        EXT_materials_bump: { bumpFactor: 0.25, bumpTexture: { index: 1 } } },
    }],
    meshes: [{ name: 'Body', primitives: [{ attributes: { POSITION: 1, JOINTS_0: 8, WEIGHTS_0: 3 }, indices: 5, material: 0 }] },
      { name: 'Coat', weights: [0.2], extras: { targetNames: ['Flutter'], opaqueIndex: 999 }, primitives: [
        { attributes: { POSITION: 0, TEXCOORD_0: 6, JOINTS_0: 2, WEIGHTS_0: 3 }, indices: 5, material: 1,
          targets: [{ POSITION: 4 }], extras: { primitiveTag: 'keep' } },
        { attributes: { POSITION: 1, JOINTS_0: 8, WEIGHTS_0: 3 }, indices: 5, material: 0, targets: [{ POSITION: 4 }] },
      ] }],
    nodes: [{ name: 'Root', translation: [0, 2, 0], children: [1, 2, 3, 4] },
      { name: 'BodyNode', mesh: 0, skin: 0 },
      { name: 'CoatNode', mesh: 1, skin: 0, weights: [0.4], extras: { sourceTag: 'first' } },
      { name: 'CoatNode', mesh: 1, skin: 0, translation: [3, 0, 0], extras: { sourceTag: 'second' } },
      { name: 'Hip', children: [5], extras: { loomlargeGarmentBone: true, shared: true } },
      { name: 'ClothRoot', children: [6] }, { name: 'ClothTip' }],
    skins: [{ name: 'Rig', joints: [4, 5, 6], skeleton: 4, inverseBindMatrices: 7, extras: { rigTag: 'keep' } }],
    scenes: [{ name: 'Donor', nodes: [0], extras: { sceneTag: 'keep' } }], scene: 0,
    animations: [{ name: 'Dropped donor clip', samplers: [], channels: [] }],
  };
  const binary = new Uint8Array(length);
  chunks.forEach((chunk) => binary.set(chunk.bytes, chunk.start));
  return { json, binary, image, bytes: garmentGlb(json, binary) };
}

test('garment extraction preserves authored streams, image bytes and extras without unselected streams', async () => {
  const fixture = garmentFixture();
  const original = fixture.bytes.slice();
  const result = await extractGarmentModel(fixture.bytes, { selections: [{ nodeIndex: 2, primitiveIndices: [0] }] });
  const { json, binary } = garmentJson(result.bytes);
  const output = await io.readBinary(result.bytes);
  const primitive = output.getRoot().listMeshes()[0].listPrimitives()[0];
  assert.deepEqual(primitive.getAttribute('POSITION').getArray(), new Float32Array([0, 0, 1, 1, 0, 1, 0, 1, 1, 7, 8, 9]));
  assert.deepEqual(primitive.getIndices().getArray(), new Uint16Array([2, 0, 1]));
  assert.equal(primitive.getAttribute('POSITION').getCount(), 4, 'unused authored vertices are retained without compaction');
  assert.deepEqual(primitive.listTargets()[0].getAttribute('POSITION').getArray(), new Float32Array([0, 0, 0, 0, 0, 0.25, 0, 0, 0, 0, 0, 0]));
  assert.deepEqual(primitive.getAttribute('JOINTS_0').getArray(), new Uint16Array([2, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0]));
  assert.deepEqual(output.getRoot().listSkins()[0].getInverseBindMatrices().getArray(), new Float32Array([
    1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
    1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
    1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
  ]));
  const imageView = json.bufferViews[json.images[0].bufferView];
  assert.deepEqual(binary.subarray(imageView.byteOffset, imageView.byteOffset + imageView.byteLength), fixture.image);
  assert.equal(json.meshes.length, 1);
  assert.equal(json.meshes[0].primitives.length, 1);
  assert.equal(json.images.length, 1);
  assert.equal(json.materials.length, 1);
  assert.equal(Buffer.from(binary).includes(Buffer.from(new Float32Array([911, 912, 913]).buffer)), false);
  assert.equal(new TextDecoder().decode(binary).includes('BODY_IMAGE_ONLY'), false);
  assert.deepEqual(json.extras, fixture.json.extras);
  assert.deepEqual(json.meshes[0].extras, fixture.json.meshes[1].extras);
  assert.deepEqual(json.samplers[0].extras, { samplerTag: 'keep' });
  assert.deepEqual(json.textures[0].extras, { textureTag: 'keep' });
  assert.deepEqual(json.materials[0].pbrMetallicRoughness.baseColorTexture.extensions,
    fixture.json.materials[1].pbrMetallicRoughness.baseColorTexture.extensions);
  assert.equal(json.materials[0].extensions.EXT_materials_bump.bumpTexture.index, 0);
  assert.equal(json.materials[0].extensions.KHR_materials_specular.specularTexture.index, 0);
  assert.equal(json.nodes.find((node) => node.name === 'Hip').extras.loomlargeGarmentBone, undefined);
  assert.equal(json.animations, undefined);
  assert.match(result.warnings.join(' '), /omits animation clips/);
  assert.deepEqual(fixture.bytes, original);
});

test('garment selection uses exact node and primitive identities for duplicate names and shared mesh instances', async () => {
  const { bytes } = garmentFixture();
  const result = await extractGarmentModel(bytes, { selections: [
    { nodeIndex: 2, primitiveIndices: [0] }, { nodeIndex: 3, primitiveIndices: [1] },
  ] });
  const { json } = garmentJson(result.bytes);
  const instances = json.nodes.filter((node) => node.mesh !== undefined);
  assert.equal(instances.length, 2);
  assert.notEqual(instances[0].mesh, instances[1].mesh);
  assert.equal(json.meshes[instances[0].mesh].primitives[0].extras.primitiveTag, 'keep');
  assert.equal(json.meshes[instances[1].mesh].primitives[0].extras, undefined);
  assert.deepEqual(instances[1].translation, [3, 0, 0]);
  assert.deepEqual(instances[0].weights, [0.4]);
});

test('explicit garment ownership retains complete weighted branches and rejects shared body joints and instances', async () => {
  const { json, binary } = garmentFixture();
  const options = { selections: [{ nodeIndex: 2, primitiveIndices: [0] }], ownedBoneNodeIndices: [5, 6] };
  await assert.rejects(extractGarmentModel(garmentGlb(json, binary), options), /unselected source primitive/);
  delete json.nodes[3].mesh;
  delete json.nodes[3].skin;
  json.nodes[4].children = [7];
  json.nodes[5].children = [8];
  json.nodes.push({ name: 'HipHelper', translation: [0, 0.2, 0], children: [5] },
    { name: 'ClothHelper', scale: [1, 2, 1], children: [6] });
  const result = await extractGarmentModel(garmentGlb(json, binary), options);
  const saved = garmentJson(result.bytes).json;
  assert.deepEqual(saved.nodes.filter((node) => node.extras?.loomlargeGarmentBone).map((node) => node.name), ['ClothRoot', 'ClothTip']);
  assert.deepEqual(saved.nodes.find((node) => node.name === 'HipHelper').translation, [0, 0.2, 0]);
  assert.deepEqual(saved.nodes.find((node) => node.name === 'ClothHelper').scale, [1, 2, 1]);
  await assert.rejects(extractGarmentModel(garmentGlb(json, binary), { ...options, ownedBoneNodeIndices: [4, 5, 6] }), /shared parent joint/);
  await assert.rejects(extractGarmentModel(garmentGlb(json, binary), { ...options, ownedBoneNodeIndices: [5] }), /complete garment-owned joint chain/);
  json.meshes[0].primitives[0].attributes.JOINTS_1 = 2;
  json.meshes[0].primitives[0].attributes.WEIGHTS_1 = 3;
  await assert.rejects(extractGarmentModel(garmentGlb(json, binary), options), /unselected source primitive/);
});

function appendGarmentFixture(fixture, array, properties = {}) {
  const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
  const offset = fixture.binary.length;
  const binary = new Uint8Array(offset + Math.ceil(bytes.length / 4) * 4);
  binary.set(fixture.binary); binary.set(bytes, offset);
  fixture.binary = binary;
  fixture.json.buffers[0].byteLength = binary.length;
  return fixture.json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, ...properties }) - 1;
}

test('ownership uses primitive indices when garment and body share vertex and joint accessors', async () => {
  const fixture = garmentFixture();
  const { json } = fixture;
  delete json.nodes[3].mesh; delete json.nodes[3].skin;
  const joints = json.bufferViews[json.accessors[2].bufferView];
  new DataView(fixture.binary.buffer).setUint16(joints.byteOffset + 3 * 8, 0, true);
  const bodyIndices = appendGarmentFixture(fixture, new Uint16Array([3, 3, 3]));
  const accessor = json.accessors.push({ bufferView: bodyIndices, componentType: 5123, type: 'SCALAR', count: 3 }) - 1;
  json.meshes[0].primitives[0].attributes = { POSITION: 0, JOINTS_0: 2, WEIGHTS_0: 3 };
  json.meshes[0].primitives[0].indices = accessor;
  const result = await extractGarmentModel(garmentGlb(json, fixture.binary), {
    selections: [{ nodeIndex: 2, primitiveIndices: [0] }], ownedBoneNodeIndices: [5, 6],
  });
  const saved = garmentJson(result.bytes).json;
  const primitive = saved.meshes[0].primitives[0];
  assert.equal(saved.accessors[primitive.attributes.POSITION].count, 4, 'shared accessor retains its original vertex numbering');
  assert.equal(saved.nodes.filter((node) => node.extras?.loomlargeGarmentBone).length, 2);
});

test('quantized vertex output remains four-byte aligned and sparse morphs retain their authored values', async () => {
  const fixture = garmentFixture();
  const { json } = fixture;
  const positions = new Int16Array([0, 0, 100, 31777, 100, 0, 100, 31777, 0, 100, 100, 31777, 7, 8, 9, 31777]);
  const view = appendGarmentFixture(fixture, positions, { byteStride: 8 });
  json.accessors[0] = { bufferView: view, componentType: 5122, type: 'VEC3', count: 4, min: [0, 0, 9], max: [100, 100, 100] };
  json.extensionsUsed.push('KHR_mesh_quantization');
  const sparseIndices = appendGarmentFixture(fixture, new Uint8Array([1]));
  const sparseValues = appendGarmentFixture(fixture, new Float32Array([0, 0, 0.25]));
  json.accessors[4] = { componentType: 5126, type: 'VEC3', count: 4,
    sparse: { count: 1, indices: { bufferView: sparseIndices, componentType: 5121, extras: { indexTag: 'keep' } },
      values: { bufferView: sparseValues, extras: { valueTag: 'keep' } }, extras: { sparseTag: 'keep' } } };
  // Generic index bufferViews may begin at an offset aligned to two, rather than four, bytes.
  const unalignedIndices = appendGarmentFixture(fixture, new Uint16Array([99, 2, 0, 1]));
  json.bufferViews[unalignedIndices].byteOffset += 2;
  json.bufferViews[unalignedIndices].byteLength = 6;
  json.accessors[5].bufferView = unalignedIndices;
  const result = await extractGarmentModel(garmentGlb(json, fixture.binary), { selections: [{ nodeIndex: 2, primitiveIndices: [0] }] });
  const saved = garmentJson(result.bytes);
  const primitive = saved.json.meshes[0].primitives[0];
  const position = saved.json.accessors[primitive.attributes.POSITION];
  const packed = saved.json.bufferViews[position.bufferView];
  assert.equal(packed.byteStride, 8);
  assert.equal(packed.byteOffset % 4, 0);
  const values = new Int16Array(saved.binary.buffer, saved.binary.byteOffset + packed.byteOffset, 16);
  assert.deepEqual([...values], [0, 0, 100, 0, 100, 0, 100, 0, 0, 100, 100, 0, 7, 8, 9, 0]);
  const morph = saved.json.accessors[primitive.targets[0].POSITION];
  assert.equal(morph.bufferView, undefined);
  assert.deepEqual(morph.sparse.extras, { sparseTag: 'keep' });
  assert.deepEqual(morph.sparse.values.extras, { valueTag: 'keep' });
  const sparse = saved.json.bufferViews[morph.sparse.values.bufferView];
  assert.deepEqual(new Float32Array(saved.binary.buffer, saved.binary.byteOffset + sparse.byteOffset, 3), new Float32Array([0, 0, 0.25]));
});

test('unsupported compression, scene extensions, external resources and invalid selections fail closed', async () => {
  for (const change of [
    (json) => { json.extensionsUsed.push('KHR_draco_mesh_compression'); },
    (json) => { json.extensionsUsed.push('KHR_lights_punctual'); json.extensions = { KHR_lights_punctual: { lights: [] } }; },
    (json) => { json.nodes[2].extensions = { UNKNOWN_payload: {} }; },
    (json) => { json.images[0].uri = 'https://example.invalid/body.png'; },
    (json) => { json.buffers[0].uri = 'model.bin'; },
    (json) => { json.bufferViews[0].byteLength += json.buffers[0].byteLength; },
    (json) => { json.accessors[0].count = 9999; },
  ]) {
    const fixture = garmentFixture(); change(fixture.json);
    await assert.rejects(extractGarmentModel(garmentGlb(fixture.json, fixture.binary), { selections: [{ nodeIndex: 2, primitiveIndices: [0] }] }));
  }
  const { bytes } = garmentFixture();
  for (const selections of [[], [{ nodeIndex: 2, primitiveIndices: [] }], [{ nodeIndex: 999, primitiveIndices: [0] }],
    [{ nodeIndex: 2, primitiveIndices: [2] }], [{ nodeIndex: 2, primitiveIndices: [0, 0] }],
    [{ nodeIndex: 2, primitiveIndices: [0] }, { nodeIndex: 2, primitiveIndices: [1] }]]) {
    await assert.rejects(extractGarmentModel(bytes, { selections }));
  }
});

test('garment extraction owns caller inputs and supports cancellation without partial output', async () => {
  const fixture = garmentFixture();
  const bytes = fixture.bytes.slice();
  const options = { selections: [{ nodeIndex: 2, primitiveIndices: [0] }] };
  const pending = extractGarmentModel(bytes, options);
  bytes.fill(0);
  options.selections[0].primitiveIndices.push(1);
  const saved = garmentJson((await pending).bytes).json;
  assert.equal(saved.meshes[0].primitives.length, 1);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(extractGarmentModel(fixture.bytes, { ...options, signal: cancelled.signal }), { name: 'AbortError' });
  const controller = new AbortController();
  const result = extractGarmentModel(fixture.bytes, { selections: [{ nodeIndex: 2, primitiveIndices: [0] }], signal: controller.signal });
  controller.abort();
  await assert.rejects(result, { name: 'AbortError' });
});
