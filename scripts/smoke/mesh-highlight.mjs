// This consumer intentionally imports no Three.js or renderer adapter.
import assert from 'node:assert/strict';
import { initEmbodyCore } from '@lovelace_lol/embody/wasm';

const wasm = await initEmbodyCore();
const core = new wasm.RuntimeCore(0);
const model = { meshes: [{ id: 4, name: 'Face' }, { id: 8, name: 'Face' }, { id: 20, name: 'Body' }] };
const snapshot = () => JSON.parse(core.evaluate_mesh_highlight_frame());
try {
  core.configure_with_profile('{}', JSON.stringify(model));
  core.request_mesh_highlight('Face');
  assert.deepEqual(snapshot().highlights.map(write => write.meshId), [4, 8]);
  const halfway = JSON.parse(core.advance_mesh_highlight(0.2));
  assert.equal(halfway.version, 1);
  assert.ok(Math.abs(halfway.highlights[0].fillIntensity - 0.175) < 1e-6);
  for (const write of halfway.highlights) {
    assert.equal(write.fillColor.length, 3);
    assert.equal(write.edgeMode, 'triangles');
    write.edgeColor.forEach((value, i) => assert.ok(Math.abs(value - write.fillColor[i] * 0.65) < 1e-6));
    assert.equal(write.edgeOpacity, write.fillIntensity);
  }
  // An unrelated renderer consumes a full ID-based snapshot without scene traversal,
  // name resolution, color derivation, or animation sampling of its own.
  const nativeSurfaces = new Map([[4, {}], [8, {}], [20, {}]]);
  const apply = frame => {
    for (const [id, surface] of nativeSurfaces) {
      surface.preview = frame.highlights.find(write => write.meshId === id);
    }
  };
  apply(halfway);
  assert.ok(nativeSurfaces.get(4).preview);
  assert.equal(nativeSurfaces.get(20).preview, undefined);
  core.request_mesh_highlight(undefined);
  apply(JSON.parse(core.advance_mesh_highlight(0.4)));
  assert.ok([...nativeSurfaces.values()].every(surface => !surface.preview));
  core.request_mesh_highlight('Body', 0xffffff, 1);
  core.advance_mesh_highlight(0.4);
  assert.deepEqual(snapshot().highlights[0].fillColor, [1, 1, 1]);
  core.configure_with_profile('{}', JSON.stringify(model));
  assert.deepEqual(snapshot(), { version: 1, highlights: [] }, 'reconfiguration clears transient state');
} finally {
  core.free();
}
