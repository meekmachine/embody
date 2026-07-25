import { describe, it, expect } from 'vitest';
import type { Profile } from './types';
import { extendPresetWithProfile, mergePresetWithProfile } from './extendPresetWithProfile';
import { requireInitializedEmbodyCore } from '../wasm';
import { CC4_PRESET } from '../presets/cc4';

const basePreset: Profile = {
  name: 'base',
  auToMorphs: { 1: { left: [], right: [], center: ['A'] } },
  auToBones: { 51: [{ node: 'HEAD', channel: 'ry', scale: 1, maxDegrees: 30 }] },
  boneNodes: { HEAD: 'Head' },
  morphToMesh: { face: ['FaceMesh'] },
  auFacePartToMeshCategory: { Eye: 'eye' },
  visemeKeys: ['viseme_aa'],
  visemeMeshCategory: 'viseme',
  annotationRegions: [
    {
      name: 'face',
      bones: ['Head'],
      paddingFactor: 1.3,
    },
  ],
};

describe('extendPresetWithProfile', () => {
  it('merges sparse host profiles through the initialized Rust core', async () => {
    const headRegion = CC4_PRESET.annotationRegions?.find((region) => region.name === 'head')
      ?? CC4_PRESET.annotationRegions?.[0];
    expect(headRegion).toBeTruthy();

    const result = await extendPresetWithProfile(CC4_PRESET, {
      annotationRegions: [{ name: headRegion!.name, paddingFactor: 1.1 }],
    });

    expect(result.annotationRegions?.find((region) => region.name === headRegion!.name)).toMatchObject({
      name: headRegion!.name,
      bones: headRegion!.bones,
      paddingFactor: 1.1,
    });
    expect(result.auToMorphs).toEqual(CC4_PRESET.auToMorphs);
  });

  it('merges maps and overrides scalars', async () => {
    const result = await extendPresetWithProfile(basePreset, {
      name: 'override',
      auToMorphs: { 2: { left: [], right: [], center: ['B'] } },
      boneNodes: { HEAD: 'CC_Base_Head' },
    });

    expect(result.name).toBe('override');
    expect(result.auToMorphs[1]).toEqual({ left: [], right: [], center: ['A'] });
    expect(result.auToMorphs[2]).toEqual({ left: [], right: [], center: ['B'] });
    expect(result.boneNodes.HEAD).toBe('CC_Base_Head');
  });

  it('merges annotation regions by name', async () => {
    const result = await extendPresetWithProfile(basePreset, {
      annotationRegions: [
        { name: 'face', meshes: ['FaceMesh2'], paddingFactor: 1.5 },
        { name: 'mouth', bones: ['Jaw'] },
      ],
    });

    const face = result.annotationRegions?.find(r => r.name === 'face');
    const mouth = result.annotationRegions?.find(r => r.name === 'mouth');

    expect(face?.meshes).toEqual(['FaceMesh2']);
    expect(face?.bones).toEqual(['Head']);
    expect(face?.paddingFactor).toBe(1.5);
    expect(mouth?.bones).toEqual(['Jaw']);
  });

  it('merges annotation camera offsets by axis instead of replacing the whole vector', async () => {
    const result = await extendPresetWithProfile(
      {
        ...basePreset,
        annotationRegions: [
          {
            name: 'face',
            bones: ['Head'],
            cameraOffset: { x: 1, y: 2, z: 3 },
          },
        ],
      },
      {
        annotationRegions: [
          { name: 'face', cameraOffset: { y: 9 } },
        ],
      }
    );

    expect(result.annotationRegions?.find((region) => region.name === 'face')?.cameraOffset).toEqual({
      x: 1,
      y: 9,
      z: 3,
    });
  });

  it('carries disabled region names without pruning annotation regions', async () => {
    const result = await extendPresetWithProfile(
      {
        ...basePreset,
        annotationRegions: [
          {
            name: 'head',
            children: ['face', 'mouth'],
          },
          ...(basePreset.annotationRegions ?? []),
          {
            name: 'mouth',
            parent: 'head',
            bones: ['Jaw'],
          },
        ],
      },
      {
        disabledRegions: ['mouth'],
      }
    );

    expect(result.disabledRegions).toEqual(['mouth']);
    expect(result.annotationRegions?.find((region) => region.name === 'mouth')).toMatchObject({
      parent: 'head',
      bones: ['Jaw'],
    });
    expect(result.annotationRegions?.find((region) => region.name === 'head')?.children).toEqual(['face', 'mouth']);
  });

  it('does not mutate the base preset', async () => {
    await extendPresetWithProfile(basePreset, {
      annotationRegions: [{ name: 'face', meshes: ['FaceMesh2'] }],
    });

    expect(basePreset.annotationRegions?.[0].meshes).toBeUndefined();
  });

  it('merges auFacePartToMeshCategory mappings', async () => {
    const result = await extendPresetWithProfile(basePreset, {
      auFacePartToMeshCategory: { Tongue: 'tongue' },
    });

    expect(result.auFacePartToMeshCategory).toEqual({
      Eye: 'eye',
      Tongue: 'tongue',
    });
  });

  it('preserves mesh categories and nested material defaults under sparse overrides', async () => {
    const result = await extendPresetWithProfile(
      {
        ...basePreset,
        meshes: {
          EyeOcclusion: {
            category: 'eyeOcclusion',
            morphCount: 94,
            material: {
              renderOrder: 2,
              transparent: true,
              depthWrite: true,
            },
          },
        },
      },
      {
        meshes: {
          EyeOcclusion: {
            material: {
              opacity: 0.5,
            },
          } as any,
        },
      },
    );

    expect(result.meshes?.EyeOcclusion).toEqual({
      category: 'eyeOcclusion',
      morphCount: 94,
      material: {
        renderOrder: 2,
        transparent: true,
        depthWrite: true,
        opacity: 0.5,
      },
    });
  });

  it('accepts an explicitly injected Wasm core', () => {
    const result = mergePresetWithProfile(requireInitializedEmbodyCore(), basePreset, {
      name: 'injected',
    });
    expect(result.name).toBe('injected');
  });
});

describe('extendPresetWithProfile reuse', () => {
  it('returns the base preset unchanged when no extension is provided', async () => {
    expect(await extendPresetWithProfile(basePreset)).toBe(basePreset);
  });

  it('applies a profile extension on top of the preset', async () => {
    const result = await extendPresetWithProfile(basePreset, {
      morphToMesh: { face: ['CustomFace'] },
    });

    expect(result.morphToMesh.face).toEqual(['CustomFace']);
  });
});
