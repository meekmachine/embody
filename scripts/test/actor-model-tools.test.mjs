import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { Document, WebIO } from '@gltf-transform/core';
import { inspectActorModel, prepareActorModel } from '@lovelace_lol/embody/model-tools';

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
