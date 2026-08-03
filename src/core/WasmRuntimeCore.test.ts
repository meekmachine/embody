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

function boneRotationsByName(frame: FrameDelta, descriptor: ModelDescriptor): Record<string, number[]> {
  const result: Record<string, number[]> = {};
  for (const write of frame.bones || []) {
    const bone = descriptor.bones.find((candidate) => candidate.id === write.boneId);
    const rotation = write.transform.rotation;
    if (bone && rotation) {
      result[bone.name] = [
        Number(rotation.x.toFixed(6)),
        Number(rotation.y.toFixed(6)),
        Number(rotation.z.toFixed(6)),
        Number(rotation.w.toFixed(6)),
      ];
    }
  }
  return result;
}

describe('WasmRuntimeCore', () => {
  it('solves AU morph FrameDelta output in Rust', async () => {
    const { profile, descriptor } = makeScene();
    const wasm = await loadWasmModule();
    const rust = new WasmRuntimeCore({ profile, model: descriptor, wasm });

    rust.setAU(1, 0.8, -0.25);

    expect(morphWritesByName(rust.evaluateMorphFrameDelta(), descriptor)).toMatchObject({
      'FaceMesh:BrowUp_L': 0.8,
      'FaceMesh:BrowUp_R': 0.6,
      'FaceMesh:BrowCenter': 0.8,
    });
  });

  it('solves weighted viseme morph aggregation in Rust', async () => {
    const { profile, descriptor } = makeScene();
    const wasm = await loadWasmModule();
    const rust = new WasmRuntimeCore({ profile, model: descriptor, wasm });

    rust.setViseme(0, 0.75);

    const rustMorphs = morphWritesByName(rust.evaluateMorphFrameDelta(), descriptor);
    expect(rustMorphs['VisemeMesh:Mouth_Aah']).toBe(0.75);
    expect(rustMorphs['VisemeMesh:Mouth_Wide']).toBe(0.375);
  });

  it('solves composite bone FrameDelta output in Rust', async () => {
    const { profile, descriptor } = makeScene();
    const wasm = await loadWasmModule();
    const rust = new WasmRuntimeCore({ profile, model: descriptor, wasm });

    rust.setContinuum(30, 31, -0.5);
    const negative = boneRotationsByName(rust.evaluateFrameDelta(), descriptor).Head;

    rust.setContinuum(30, 31, 0.25);
    const positive = boneRotationsByName(rust.evaluateFrameDelta(), descriptor).Head;

    expect(negative).toEqual([0, -0.087156, 0, 0.996195]);
    expect(positive).toEqual([0, 0.043619, 0, 0.999048]);
  });

  it('solves viseme jaw bone output in Rust', async () => {
    const { profile, descriptor } = makeScene();
    const wasm = await loadWasmModule();
    const rust = new WasmRuntimeCore({ profile, model: descriptor, wasm });

    rust.setViseme(0, 0.8, 0.5);

    const jaw = boneRotationsByName(rust.evaluateFrameDelta(), descriptor).Jaw;
    expect(jaw[0]).toBe(0);
    expect(jaw[1]).toBe(0);
    expect(jaw[2]).toBeGreaterThan(0.05);
    expect(jaw[3]).toBeLessThan(1);
  });

  it('self-configures from profile and model JSON matching the Wasm facade', async () => {
    const { profile, descriptor } = makeScene();
    const wasm = await loadWasmModule();

    const reference = new WasmRuntimeCore({ profile, model: descriptor, wasm });
    const selfConfigured = new wasm.RuntimeCore(0);
    selfConfigured.configure(JSON.stringify(profile), JSON.stringify(descriptor));

    reference.setAU(1, 0.8, -0.25);
    selfConfigured.set_au_signed(1, 0.8, -0.25);
    reference.setViseme(0, 0.75);
    selfConfigured.set_viseme(0, 0.75);

    const toWrites = (packed: Float32Array) =>
      morphWritesByName({ morphTargets: unpackMorphFrameDelta(packed) } as FrameDelta, descriptor);
    const referenceMorphs = toWrites(reference.evaluatePackedMorphFrameDelta());
    const selfMorphs = toWrites(selfConfigured.evaluate_morph_frame_delta());
    expect(Object.keys(selfMorphs).length).toBeGreaterThan(0);
    expect(selfMorphs).toEqual(referenceMorphs);

    // Continuum pairs are compiled in Rust too: negative routes to the pair AU.
    selfConfigured.set_au_signed(31, -0.5, 0);
    expect(selfConfigured.get_au(30)).toBeCloseTo(0.5, 6);
    expect(selfConfigured.get_au(31)).toBe(0);
    reference.setAU(31, 0, 0);
    reference.setAU(30, 0.5, 0);
    expect(selfConfigured.viseme_slot_index('aa')).toBe(0);
    expect(selfConfigured.viseme_slot_index('bmp')).toBe(1);

    const referenceBones = Array.from(reference.evaluatePackedBoneFrameDelta());
    const selfBones = Array.from(selfConfigured.evaluate_bone_frame_delta());
    expect(selfBones.length).toBe(referenceBones.length);
    selfBones.forEach((value, index) => {
      expect(value).toBeCloseTo(referenceBones[index], 5);
    });

    selfConfigured.free?.();
  });

  it('runs eased transitions inside the Rust core via update(dt)', async () => {
    const { profile, descriptor } = makeScene();
    const wasm = await loadWasmModule();
    const core = new wasm.RuntimeCore(0);
    core.configure(JSON.stringify(profile), JSON.stringify(descriptor));

    core.transition_au(1, 1.0, 200, Number.NaN);
    expect(core.active_transition_count()).toBe(1);

    core.update(0.1); // easeInOutQuad(0.5) = 0.5
    expect(core.get_au(1)).toBeCloseTo(0.5, 6);

    core.update(0.2);
    expect(core.get_au(1)).toBeCloseTo(1.0, 6);
    expect(core.active_transition_count()).toBe(0);

    core.free?.();
  });

  it('unpacks packed morph frame deltas', () => {
    const writes = unpackMorphFrameDelta(new Float32Array([1, 10, 0.5, 0, 2, 20, 0.25, 1]));
    expect(writes).toEqual([
      { meshId: 1, morphTargetId: 10, value: 0.5, mode: 'absolute' },
      { meshId: 2, morphTargetId: 20, value: 0.25, mode: 'additive' },
    ]);
  });
});
