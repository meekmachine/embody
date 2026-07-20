import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ThreeModelInspector } from '../engines/three/ThreeModelInspector';
import { makeProfileTestScene } from '../engines/three/profileTestScene';
import { TsRuntimeCore } from './TsRuntimeCore';
import { WasmRuntimeCore, unpackMorphFrameDelta } from './WasmRuntimeCore';
import type { EmbodyCoreWasmModule } from '../wasmTypes';
import type { FrameDelta, ModelDescriptor } from './contracts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function loadWasmModule(): Promise<EmbodyCoreWasmModule> {
  const wasmJs = path.join(repoRoot, 'dist/wasm/embody_wasm.js');
  const wasmBin = path.join(repoRoot, 'dist/wasm/embody_wasm_bg.wasm');
  const mod = await import(pathToFileURL(wasmJs).href) as EmbodyCoreWasmModule;
  if (typeof mod.default === 'function') {
    await mod.default({ module_or_path: await readFile(wasmBin) });
  }
  if (!mod.RuntimeCore) {
    throw new Error('Generated Wasm artifacts are missing RuntimeCore. Run npm run wasm:build.');
  }
  return mod;
}

function makeScene() {
  const scene = makeProfileTestScene();
  const descriptor = new ThreeModelInspector().inspectModel(scene.model, {
    meshes: [scene.face, scene.viseme, scene.hair],
    profile: scene.profile,
  }).descriptor;
  return { ...scene, descriptor };
}

function morphWritesByName(frame: FrameDelta, descriptor: ModelDescriptor): Record<string, number> {
  const result: Record<string, number> = {};
  for (const write of frame.morphTargets || []) {
    const morph = descriptor.morphTargets.find((target) => target.id === write.morphTargetId);
    const mesh = descriptor.meshes.find((candidate) => candidate.id === write.meshId);
    if (morph && mesh) {
      result[`${mesh.name}:${morph.name}`] = Number(write.value.toFixed(6));
    }
  }
  return result;
}

describe('WasmRuntimeCore', () => {
  it('matches TsRuntimeCore AU morph FrameDelta output', async () => {
    const { profile, descriptor } = makeScene();
    const wasm = await loadWasmModule();
    const ts = new TsRuntimeCore({ profile, model: descriptor });
    const rust = new WasmRuntimeCore({ profile, model: descriptor, wasm });

    ts.setAU(1, 0.8, -0.25);
    rust.setAU(1, 0.8, -0.25);

    expect(morphWritesByName(rust.evaluateMorphFrameDelta(), descriptor)).toMatchObject(
      morphWritesByName(ts.evaluateFrameDelta(), descriptor)
    );
  });

  it('matches TsRuntimeCore viseme morph aggregation', async () => {
    const { profile, descriptor } = makeScene();
    const wasm = await loadWasmModule();
    const ts = new TsRuntimeCore({ profile, model: descriptor });
    const rust = new WasmRuntimeCore({ profile, model: descriptor, wasm });

    ts.setVisemeById('aa', 0.75);
    rust.setViseme(0, 0.75);

    const tsMorphs = morphWritesByName(ts.evaluateFrameDelta(), descriptor);
    const rustMorphs = morphWritesByName(rust.evaluateMorphFrameDelta(), descriptor);
    expect(rustMorphs['VisemeMesh:Mouth_Aah']).toBe(tsMorphs['VisemeMesh:Mouth_Aah']);
    expect(rustMorphs['VisemeMesh:Mouth_Wide']).toBe(tsMorphs['VisemeMesh:Mouth_Wide']);
  });

  it('unpacks packed morph frame deltas', () => {
    const writes = unpackMorphFrameDelta(new Float32Array([1, 10, 0.5, 0, 2, 20, 0.25, 1]));
    expect(writes).toEqual([
      { meshId: 1, morphTargetId: 10, value: 0.5, mode: 'absolute' },
      { meshId: 2, morphTargetId: 20, value: 0.25, mode: 'additive' },
    ]);
  });
});
