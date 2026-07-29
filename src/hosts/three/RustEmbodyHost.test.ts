import { BufferAttribute, BufferGeometry, Mesh, Object3D, Skeleton, SkinnedMesh } from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { EmbodyCoreWasmModule } from '../../wasmTypes';
import { setEmbodyCoreForTests } from '../../wasm';
import { RustEmbodyHost } from './RustEmbodyHost';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

async function loadWasmModule(): Promise<EmbodyCoreWasmModule> {
  const wasmJs = path.join(repoRoot, 'dist/wasm/embody_wasm.js');
  const wasmBin = path.join(repoRoot, 'dist/wasm/embody_wasm_bg.wasm');
  const mod = await import(pathToFileURL(wasmJs).href) as EmbodyCoreWasmModule;
  if (typeof mod.default === 'function') {
    await mod.default({ module_or_path: await readFile(wasmBin) });
  }
  setEmbodyCoreForTests(mod);
  return mod;
}

function makeModel() {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
  geometry.morphAttributes.position = [
    new BufferAttribute(new Float32Array([0, 0.1, 0, 1, 0.1, 0, 0, 1.1, 0]), 3),
    new BufferAttribute(new Float32Array([0, 0.2, 0, 1, 0.2, 0, 0, 1.2, 0]), 3),
  ];
  const face = new Mesh(geometry);
  face.name = 'CC_Base_Body';
  face.morphTargetDictionary = {
    Brow_Raise_Inner_L: 0,
    Brow_Raise_Inner_R: 1,
  };
  face.morphTargetInfluences = [0, 0];

  const root = new Object3D();
  root.name = 'Root';
  const head = new Object3D();
  head.name = 'CC_Base_Head';
  root.add(head);
  root.add(face);
  return { model: root, face, head };
}

describe('RustEmbodyHost (hosts/three)', () => {
  beforeAll(async () => {
    await loadWasmModule();
  });

  it('does not import Embody.ts (thin host boundary)', async () => {
    const source = await readFile(
      path.join(repoRoot, 'src/hosts/three/RustEmbodyHost.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/from ['"].*Embody['"]/);
    expect(source).not.toMatch(/engines\/three\/Embody/);
    // Runtime configure must use Wasm embedded presets (not TS preset as SoT).
    expect(source).toMatch(/configure_with_preset/);
    expect(source).toMatch(/merge_embedded_preset/);
  });

  it('loads embedded CC4 from Wasm and applies AU morphs', async () => {
    const { model, face } = makeModel();
    const wasm = await loadWasmModule();
    const host = await RustEmbodyHost.create(model, {
      presetType: 'cc4',
      meshes: [face],
      wasm,
      profile: {
        auToMorphs: {
          1: { left: ['Brow_Raise_Inner_L'], right: ['Brow_Raise_Inner_R'], center: [] },
        },
        morphToMesh: {
          Brow_Raise_Inner_L: ['CC_Base_Body'],
          Brow_Raise_Inner_R: ['CC_Base_Body'],
        },
      } as any,
    });

    expect(host.getProfile().auToMorphs).toBeTruthy();
    host.setAU(1, 0.8);
    expect(host.getAU(1)).toBeCloseTo(0.8, 3);
    expect(Math.max(...(face.morphTargetInfluences ?? [0]))).toBeGreaterThan(0.1);
    host.dispose();
  });

  it('supports unbound create + onReady', async () => {
    const { model, face } = makeModel();
    await loadWasmModule();
    const host = RustEmbodyHost.createUnbound({ presetType: 'cc4' });
    host.onReady({ model, meshes: [face] });
    host.setAU(1, 0.5);
    expect(host.getAU(1)).toBeCloseTo(0.5, 3);
    host.dispose();
  });
});
