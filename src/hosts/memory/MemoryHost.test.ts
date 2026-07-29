import { describe, expect, it } from 'vitest';
import type { ModelDescriptor } from '../../core/contracts';
import { initEmbodyCore } from '../../wasm';
import { MemoryHost } from './MemoryHost';

function makeDescriptor(): ModelDescriptor {
  return {
    meshes: [
      { id: 0, name: 'CC_Base_Body', morphTargetIds: [0, 1], visible: true },
    ],
    morphTargets: [
      { id: 0, meshId: 0, name: 'Brow_Raise_Inner_L', hostIndex: 0 },
      { id: 1, meshId: 0, name: 'Brow_Raise_Inner_R', hostIndex: 1 },
    ],
    bones: [],
  };
}

describe('MemoryHost', () => {
  it('drives RuntimeCore without Three.js and records packed morph writes', async () => {
    const wasm = await initEmbodyCore();
    expect(wasm.has_preset('cc4')).toBe(true);
    expect(wasm.list_presets()).toEqual(expect.arrayContaining(['cc4', 'fish']));

    // Pure embedded CC4 + model descriptor that matches CC4 morph/mesh names.
    const host = await MemoryHost.create(makeDescriptor(), {
      presetId: 'cc4',
      wasm,
    });

    host.setAU(1, 0.75);
    expect(host.getAU(1)).toBeCloseTo(0.75, 3);
    expect(host.morphValues.size).toBeGreaterThan(0);
    const values = [...host.morphValues.values()];
    expect(Math.max(...values)).toBeGreaterThan(0.1);

    host.dispose();
  });

  it('loads fish embedded preset via sync create', async () => {
    await initEmbodyCore();
    const host = MemoryHost.createSync(makeDescriptor(), { presetId: 'fish' });
    const merged = JSON.parse(host.mergedProfileJson());
    expect(merged.auToBones || merged.auToMorphs).toBeTruthy();
    host.dispose();
  });
});
