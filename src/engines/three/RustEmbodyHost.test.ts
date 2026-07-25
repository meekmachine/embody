import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Object3D } from 'three';
import type { EmbodyCoreWasmModule } from '../../wasmTypes';
import {
  FACE_MORPHS,
  VISEME_MORPHS,
  makeMorphMesh,
  makeTestProfile,
  snapshotMorphInfluences,
} from './profileTestScene';
import { RustEmbodyHost } from './RustEmbodyHost';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

async function loadWasmModule(): Promise<EmbodyCoreWasmModule> {
  const wasmJs = path.join(repoRoot, 'dist/wasm/embody_wasm.js');
  const wasmBin = path.join(repoRoot, 'dist/wasm/embody_wasm_bg.wasm');
  const mod = await import(pathToFileURL(wasmJs).href) as EmbodyCoreWasmModule;
  if (typeof mod.default === 'function') {
    await mod.default({ module_or_path: await readFile(wasmBin) });
  }
  return mod;
}

function makeModel() {
  const model = new Object3D();
  model.name = 'RustHostTestModel';
  const head = new Object3D();
  head.name = 'Head';
  const jaw = new Object3D();
  jaw.name = 'Jaw';
  const face = makeMorphMesh('FaceMesh', FACE_MORPHS);
  const viseme = makeMorphMesh('VisemeMesh', VISEME_MORPHS);
  model.add(head, jaw, face, viseme);
  return { model, head, jaw, face, viseme };
}

async function makeHost() {
  const scene = makeModel();
  const wasm = await loadWasmModule();
  const host = await RustEmbodyHost.create(scene.model, {
    profile: makeTestProfile(),
    meshes: [scene.face, scene.viseme],
    wasm,
  });
  return { ...scene, host };
}

describe('RustEmbodyHost', () => {
  it('applies AU morphs evaluated by the Rust core', async () => {
    const { host, face } = await makeHost();

    host.setAU(1, 0.8, -0.25);
    const influences = snapshotMorphInfluences(face);
    expect(influences.BrowCenter).toBeCloseTo(0.8, 6);
    expect(influences.BrowUp_L).toBeGreaterThan(0);
    expect(influences.BrowUp_R).toBeGreaterThan(0);
    expect(influences.BrowUp_L).toBeGreaterThan(influences.BrowUp_R);

    host.setAU(1, 0);
    expect(snapshotMorphInfluences(face).BrowCenter).toBe(0);
    host.dispose();
  });

  it('applies composite bone rotations through the continuum', async () => {
    const { host, head } = await makeHost();

    host.setContinuum(30, 31, -0.5);
    expect(host.getContinuum(30, 31)).toBeCloseTo(-0.5, 6);
    const rotated = head.quaternion.clone();
    expect(Math.abs(rotated.y)).toBeGreaterThan(0.01);

    host.setContinuum(30, 31, 0);
    expect(Math.abs(head.quaternion.y)).toBeLessThan(1e-6);
    host.dispose();
  });

  it('runs transitions in the Rust core and applies each update tick', async () => {
    const { host, face } = await makeHost();

    host.transitionAU(2, 1.0, 200);
    expect(host.activeTransitionCount()).toBe(1);

    host.update(0.1); // easeInOutQuad(0.5) = 0.5
    expect(snapshotMorphInfluences(face).Smile).toBeCloseTo(0.5, 6);

    host.update(0.2);
    expect(snapshotMorphInfluences(face).Smile).toBeCloseTo(1.0, 6);
    expect(host.activeTransitionCount()).toBe(0);
    host.dispose();
  });

  it('applies visemes with weights and jaw rotation', async () => {
    const { host, viseme, jaw } = await makeHost();

    host.setVisemeById('aa', 0.75);
    const influences = snapshotMorphInfluences(viseme);
    expect(influences.Mouth_Aah).toBeCloseTo(0.75, 6);
    expect(influences.Mouth_Wide).toBeCloseTo(0.375, 6);
    expect(Math.abs(jaw.quaternion.z)).toBeGreaterThan(0.01);

    host.setVisemeById('aa', 0);
    expect(snapshotMorphInfluences(viseme).Mouth_Aah).toBe(0);
    expect(Math.abs(jaw.quaternion.z)).toBeLessThan(1e-6);
    host.dispose();
  });
});
