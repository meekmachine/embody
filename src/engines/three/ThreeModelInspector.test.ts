import { describe, expect, it } from 'vitest';
import { AnimationClip, NumberKeyframeTrack, Object3D } from 'three';
import { makeMorphMesh, makeProfileTestScene, makeTestProfile } from './profileTestScene';
import { ThreeModelInspector } from './ThreeModelInspector';

describe('ThreeModelInspector', () => {
  it('describes meshes, morph targets, bones, and adapter lookups', () => {
    const { model, face, viseme, profile } = makeProfileTestScene();
    const inspector = new ThreeModelInspector();

    const inspection = inspector.inspectModel(model, {
      meshes: [face, viseme],
      profile,
    });

    expect(inspection.morphMeshes.map((mesh) => mesh.name)).toEqual([
      'FaceMesh',
      'VisemeMesh',
      'HairMesh',
    ]);
    expect(inspection.meshByName.get('FaceMesh')).toBe(face);
    expect(inspection.bones.HEAD?.obj.name).toBe('Head');
    expect(inspection.bones.JAW?.obj.name).toBe('Jaw');
    expect(inspection.resolvedFaceMeshes).toEqual(['FaceMesh']);
    expect(inspection.faceMesh).toBe(face);

    expect(inspection.descriptor.meshes.map((mesh) => ({
      name: mesh.name,
      morphTargetCount: mesh.morphTargetIds.length,
    }))).toEqual([
      { name: 'FaceMesh', morphTargetCount: 7 },
      { name: 'VisemeMesh', morphTargetCount: 3 },
      { name: 'HairMesh', morphTargetCount: 7 },
    ]);
    expect(inspection.descriptor.morphTargets.slice(0, 3).map((target) => ({
      name: target.name,
      hostIndex: target.hostIndex,
    }))).toEqual([
      { name: 'BrowUp_L', hostIndex: 0 },
      { name: 'BrowUp_R', hostIndex: 1 },
      { name: 'BrowCenter', hostIndex: 2 },
    ]);
    expect(inspection.descriptor.bones.map((bone) => bone.name).sort()).toEqual([
      'Head',
      'Jaw',
    ]);
  });

  it('keeps named static meshes addressable outside morph mesh collection', () => {
    const model = new Object3D();
    const face = makeMorphMesh('FaceMesh', ['Brow_Drop_L']);
    const staticMesh = makeMorphMesh('BodyMesh');
    model.add(face, staticMesh);

    const inspection = new ThreeModelInspector().inspectModel(model, {
      meshes: [],
      profile: makeTestProfile({
        morphToMesh: { face: ['FaceMesh'] },
      }),
    });

    expect(inspection.morphMeshes.map((mesh) => mesh.name)).toEqual(['FaceMesh']);
    expect(inspection.meshByName.get('BodyMesh')).toBe(staticMesh);
  });

  it('describes animation tracks without exposing Three clips in the core descriptor shape', () => {
    const { model, face, profile } = makeProfileTestScene();
    const clip = new AnimationClip('Blink', 1, [
      new NumberKeyframeTrack(`${face.uuid}.morphTargetInfluences[0]`, [0, 1], [0, 1]),
    ]);

    const inspection = new ThreeModelInspector().inspectModel(model, {
      profile,
      animations: [clip],
    });

    expect(inspection.animations).toEqual([
      {
        name: 'Blink',
        duration: 1,
        tracks: [
          {
            name: `${face.uuid}.morphTargetInfluences[0]`,
            targetName: face.uuid,
            property: 'morphTargetInfluences[0]',
            type: 'morph',
            keyframeCount: 2,
            valueSize: 1,
            valueRange: { min: [0], max: [1] },
          },
        ],
        animatedBones: [],
        animatedMorphs: [`${face.uuid}.morphTargetInfluences[0]`],
      },
    ]);
    expect(inspection.descriptor.metadata?.animations).toEqual(inspection.animations);
  });
});
