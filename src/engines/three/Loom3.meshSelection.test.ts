import { describe, expect, it } from 'vitest';
import { BufferGeometry, Mesh, MeshBasicMaterial, Object3D } from 'three';
import { Loom3 } from './Loom3';

function makeMorphMesh(name: string, morphKeys: string[]): Mesh {
  const mesh = new Mesh(new BufferGeometry(), new MeshBasicMaterial());
  mesh.name = name;
  (mesh as any).morphTargetDictionary = Object.fromEntries(morphKeys.map((key, index) => [key, index]));
  (mesh as any).morphTargetInfluences = new Array(morphKeys.length).fill(0);
  return mesh;
}

describe('Loom3 face mesh fallback selection', () => {
  it('seeds morphToMesh.face from resolved face meshes (not all morph meshes)', () => {
    const face = makeMorphMesh('FaceMesh', ['Brow_Drop_L']);
    const hair = makeMorphMesh('HairMesh', ['Brow_Drop_L']);

    const model = new Object3D();
    model.add(face, hair);

    const engine = new Loom3({
      presetType: 'cc4',
      profile: {
        morphToMesh: { face: [] },
        auToMorphs: { 999: { left: [], right: [], center: ['Brow_Drop_L'] } },
      },
    });

    engine.onReady({ model, meshes: [face, hair] });

    const profile = engine.getProfile();
    expect(profile.morphToMesh.face).toEqual(['FaceMesh']);
  });

  it('transitionAU applies only to selected face mesh mapping by default', () => {
    const face = makeMorphMesh('FaceMesh', ['Brow_Drop_L']);
    const hair = makeMorphMesh('HairMesh', ['Brow_Drop_L']);

    const model = new Object3D();
    model.add(face, hair);

    const engine = new Loom3({
      presetType: 'cc4',
      profile: {
        morphToMesh: { face: [] },
        auToMorphs: { 999: { left: [], right: [], center: ['Brow_Drop_L'] } },
      },
    });

    engine.onReady({ model, meshes: [face, hair] });
    engine.transitionAU(999, 1, 0);

    const faceIndex = face.morphTargetDictionary?.['Brow_Drop_L'];
    const hairIndex = hair.morphTargetDictionary?.['Brow_Drop_L'];
    expect(faceIndex).toBeTypeOf('number');
    expect(hairIndex).toBeTypeOf('number');

    expect(face.morphTargetInfluences?.[faceIndex as number]).toBe(1);
    expect(hair.morphTargetInfluences?.[hairIndex as number]).toBe(0);
  });

  it('routes AU meshes using configurable auFacePartToMeshCategory', () => {
    const face = makeMorphMesh('FaceMesh', ['Eye_Blink_L']);
    const eye = makeMorphMesh('EyeMesh', ['Eye_Blink_L']);

    const model = new Object3D();
    model.add(face, eye);

    const engine = new Loom3({
      presetType: 'cc4',
      profile: {
        morphToMesh: { face: ['FaceMesh'], eye: ['EyeMesh'] },
        auToMorphs: { 43: { left: ['Eye_Blink_L'], right: [], center: [] } },
        auInfo: { '43': { id: '43', name: 'Blink', facePart: 'Eyelids' } },
        auFacePartToMeshCategory: { Eyelids: 'eye' },
      },
    });

    engine.onReady({ model, meshes: [face, eye] });
    engine.setAU(43, 1);

    const faceIndex = face.morphTargetDictionary?.['Eye_Blink_L'];
    const eyeIndex = eye.morphTargetDictionary?.['Eye_Blink_L'];
    expect(faceIndex).toBeTypeOf('number');
    expect(eyeIndex).toBeTypeOf('number');

    expect(face.morphTargetInfluences?.[faceIndex as number]).toBe(0);
    expect(eye.morphTargetInfluences?.[eyeIndex as number]).toBe(1);
  });

  it('exposes typed lip-sync playback on the top-level engine wrapper', () => {
    const face = makeMorphMesh('VisemeMesh', ['Ah', 'Jaw_Open']);
    const jaw = new Object3D();
    jaw.name = 'JawRoot';

    const model = new Object3D();
    model.add(face, jaw);

    const engine = new Loom3({
      presetType: 'cc4',
      profile: {
        auToMorphs: {
          26: { left: [], right: [], center: ['Jaw_Open'] },
        },
        auToBones: {
          26: [{ node: 'JAW', channel: 'rz', scale: 1, maxDegrees: 30 }],
        },
        boneNodes: { JAW: 'JawRoot' },
        morphToMesh: { face: ['VisemeMesh'], viseme: ['VisemeMesh'] },
        visemeKeys: ['Ah'],
        visemeMeshCategory: 'viseme',
      },
    });

    engine.onReady({ model, meshes: [face] });

    const clip = engine.typedSnippetToClip('typed-wrapper-lipsync', [
      {
        target: { type: 'viseme', id: 0 },
        keyframes: [{ time: 0, intensity: 0 }, { time: 0.12, intensity: 1 }, { time: 0.24, intensity: 0 }],
      },
      {
        target: { type: 'bone', id: 'JAW', channel: 'rz', maxDegrees: 30 },
        keyframes: [{ time: 0, intensity: 0 }, { time: 0.12, intensity: 0.5 }, { time: 0.24, intensity: 0 }],
      },
    ], { autoVisemeJaw: false });

    expect(clip).toBeTruthy();
    const trackNames = clip!.tracks.map((track) => track.name);
    expect(trackNames).toContain(`${face.uuid}.morphTargetInfluences[0]`);
    expect(trackNames).not.toContain(`${face.uuid}.morphTargetInfluences[1]`);
    expect(trackNames).toContain(`${jaw.uuid}.quaternion`);
  });
});
