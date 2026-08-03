import { describe, expect, it } from 'vitest';
import { requireInitializedEmbodyCore } from '../wasm';
import { resolveRustEmbeddedProfileView, resolveRustProfileView } from './rustResolvedProfile';

describe('Rust resolved profile view', () => {
  it('returns host routing metadata from the Rust profile core', () => {
    const wasm = requireInitializedEmbodyCore();
    const view = resolveRustProfileView(wasm, {
      auToMorphs: {
        1: { left: [], right: [], center: ['EyeBlink'] },
        12: { left: [], right: [], center: ['Smile'] },
      },
      auToBones: {
        51: [{ node: 'HEAD', channel: 'ry', scale: 1, maxDegrees: 30 }],
      },
      boneNodes: { HEAD: 'Head' },
      morphToMesh: {
        face: ['FaceMesh'],
        eye: ['EyeMesh'],
        viseme: ['MouthMesh'],
      },
      auInfo: {
        1: { facePart: 'Eye' },
        12: { facePart: 'Mouth' },
      },
      auFacePartToMeshCategory: {
        Eye: 'eye',
      },
      visemeSlots: [
        { id: 'bmp', label: 'BMP', order: 2, defaultJawAmount: 0.1 },
        { id: 'aa', label: 'AA', order: 1, defaultJawAmount: 0.8 },
      ],
      visemeBindings: {
        aa: { targets: [{ morph: 'Aah', weight: 0.75 }] },
        bmp: { morph: 'BMP' },
      },
      meshes: {
        EyeMesh: {
          category: 'eye',
          morphCount: 8,
          material: {
            renderOrder: -10,
            transparent: true,
            depthWrite: false,
          },
        },
      },
      mappingSections: [
        { id: 'Eye', label: 'Eye', kind: 'au', order: 1, meshCategory: 'eye' },
      ],
      visemeKeys: [],
    });

    expect(view.visemeSlots.map((slot) => slot.id)).toEqual(['aa', 'bmp']);
    expect(view.visemeJawAmounts).toEqual([0.8, 0.1]);
    expect(view.visemeBindingTargets[0]).toEqual([{ morph: 'Aah', weight: 0.75 }]);
    expect(view.visemeMeshCategory).toBe('viseme');
    expect(view.visemeMeshNames).toEqual(['MouthMesh']);
    expect(view.auMeshNames['1']).toEqual(['EyeMesh']);
    expect(view.auMeshNames['12']).toEqual(['FaceMesh']);
    expect(view.meshes.EyeMesh).toMatchObject({
      category: 'eye',
      morphCount: 8,
      material: {
        renderOrder: -10,
        transparent: true,
        depthWrite: false,
      },
    });
    expect(view.mappingSections[0]).toMatchObject({ meshCategory: 'eye' });
  });

  it('preserves embedded preset mesh categories and material overrides', () => {
    const wasm = requireInitializedEmbodyCore();
    const view = resolveRustEmbeddedProfileView(wasm, 'fish', {
      meshes: {
        EYES_0: { material: { opacity: 0.5 } },
      },
    });

    expect(view.meshes.EYES_0).toMatchObject({
      category: 'eye',
      material: {
        renderOrder: 17,
        transparent: true,
        opacity: 0.5,
        depthWrite: true,
        depthTest: true,
        blending: 'Normal',
      },
    });
    expect(view.meshes.Cube_0.material).toMatchObject({
      renderOrder: -20,
      opacity: 0,
    });
  });
});
