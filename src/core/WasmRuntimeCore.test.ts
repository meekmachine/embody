import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ThreeModelInspector } from '../engines/three/ThreeModelInspector';
import { makeProfileTestScene } from '../engines/three/profileTestScene';
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
  it('evaluates AU morph FrameDelta through Rust', async () => {
    const { profile, descriptor } = makeScene();
    const wasm = await loadWasmModule();
    const rust = new WasmRuntimeCore({ profile, model: descriptor, wasm });

    rust.setAU(1, 0.8, -0.25);
    const morphs = morphWritesByName(rust.evaluateMorphFrameDelta(), descriptor);

    expect(Object.keys(morphs).length).toBeGreaterThan(0);
    for (const value of Object.values(morphs)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('aggregates viseme morphs through Rust', async () => {
    const { profile, descriptor } = makeScene();
    const wasm = await loadWasmModule();
    const rust = new WasmRuntimeCore({ profile, model: descriptor, wasm });

    rust.setViseme(0, 0.75);
    const morphs = morphWritesByName(rust.evaluateMorphFrameDelta(), descriptor);

    expect(morphs['VisemeMesh:Mouth_Aah']).toBeGreaterThan(0);
    expect(morphs['VisemeMesh:Mouth_Wide']).toBeGreaterThan(0);
  });

  it('evaluates composite bone FrameDelta through Rust', async () => {
    const { profile, descriptor } = makeScene();
    const wasm = await loadWasmModule();
    const rust = new WasmRuntimeCore({ profile, model: descriptor, wasm });

    rust.setAU(30, 0.5, 0);
    rust.setAU(31, 0, 0);
    const bones = rust.evaluateFrameDelta().bones ?? [];
    expect(bones.length).toBeGreaterThan(0);
    expect(bones.some((write) => write.transform.rotation)).toBe(true);
  });

  it('evaluates viseme jaw bone output through Rust', async () => {
    const { profile, descriptor } = makeScene();
    const wasm = await loadWasmModule();
    const rust = new WasmRuntimeCore({ profile, model: descriptor, wasm });

    rust.setViseme(0, 0.8, 0.5);
    const jaw = (rust.evaluateFrameDelta().bones ?? []).find(
      (write) => write.transform.rotation
        && Math.abs(write.transform.rotation.w - 1) > 1e-6
    );
    expect(jaw).toBeTruthy();
  });

  it('unpacks packed morph frame deltas', () => {
    const packed = Float32Array.from([
      1, 2, 0.5, 0,
      3, 4, 0.25, 1,
    ]);
    expect(unpackMorphFrameDelta(packed)).toEqual([
      { meshId: 1, morphTargetId: 2, value: 0.5, mode: 'absolute' },
      { meshId: 3, morphTargetId: 4, value: 0.25, mode: 'additive' },
    ]);
  });
});
