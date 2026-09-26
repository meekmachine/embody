import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { detectAnnotationLaterality, getWorldDirectionForCameraAngle, resolveAnnotationCharacterConfig, resolveBoneNames, resolveFaceCenter, resolveRegionCameraAngle } from '../adapter';

describe('standalone annotation profile and Three adapter', () => {
  it('resolves preset regions without serializing or replacing host-only metadata', async () => {
    const hostData = { get vertices(): never { throw new Error('host metadata must not be serialized'); } };
    const result = await resolveAnnotationCharacterConfig({ characterId: 'standalone', auPresetType: 'cc4', authoredMorphs: hostData });
    expect(result.regions?.length).toBeGreaterThan(0);
    expect(result.boneNodes).toBeDefined();
    expect(result.auToMorphs).toBeDefined();
    expect(result.auToBones).toBeDefined();
    expect(result.morphToMesh).toBeDefined();
    expect(result.authoredMorphs).toBe(hostData);
  });

  it('preserves explicit custom annotations and filters disabled preset regions', async () => {
    const result = await resolveAnnotationCharacterConfig({ characterId: 'customized', auPresetType: 'cc4', annotationRegions: [{ name: 'custom', bones: ['Head'] }], disabledRegions: ['left_eye'] });
    expect(result.regions?.some(r => r.name === 'custom')).toBe(true);
    expect(result.regions?.some(r => r.name === 'left_eye')).toBe(false);
    const custom = await resolveAnnotationCharacterConfig({ characterId: 'custom', auPresetType: 'custom', annotationRegions: [{ name: 'point', customPosition: { x: 1, y: 2, z: 3 } }] });
    expect(custom.regions).toEqual(custom.annotationRegions);
  });

  it('resolves bone affixes and derives laterality from model-local bone positions', () => {
    const model = new THREE.Group(); model.rotation.y = Math.PI / 2;
    const left = new THREE.Bone(); left.name = 'Rig_LeftEye_suffix'; left.position.x = 0.2; model.add(left);
    const right = new THREE.Bone(); right.name = 'Rig_RightEye_suffix'; right.position.x = -0.2; model.add(right);
    const profile = { boneNodes: { left_eye: 'LeftEye', right_eye: 'RightEye' }, bonePrefix: 'Rig_', boneSuffix: '_suffix' };
    expect(resolveBoneNames(['left_eye', 'left_eye'], profile)).toEqual(['Rig_LeftEye_suffix', 'LeftEye']);
    const laterality = detectAnnotationLaterality(model, [{ name: 'left_eye', bones: ['left_eye'] }, { name: 'right_eye', bones: ['right_eye'] }], profile);
    expect(laterality.leftSideX).toBe(1);
    expect(laterality.confidence).toBeCloseTo(1);
    expect(resolveRegionCameraAngle({ name: 'left_eye', cameraAngle: 270 }, laterality)).toBe(90);
    expect(getWorldDirectionForCameraAngle(model, 0).x).toBeCloseTo(1);
  });

  it('uses explicit face meshes before eyes, eyes before head offsets, and retains fallback height', () => {
    const model = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1)); body.name = 'Body'; model.add(body);
    const left = new THREE.Bone(); left.name = 'LeftEye'; left.position.set(-0.1, 0.8, 0.2); model.add(left);
    const right = new THREE.Bone(); right.name = 'RightEye'; right.position.set(0.1, 0.8, 0.2); model.add(right);
    const head = new THREE.Bone(); head.name = 'Head'; head.position.y = 0.6; model.add(head);
    const face = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2)); face.name = 'Face'; face.position.set(0, 0.7, 0.3); model.add(face);
    expect(resolveFaceCenter(model, { name: 'face', meshes: ['Face'] }).center.toArray()).toEqual([0, 0.7, 0.3]);
    expect(resolveFaceCenter(model, { name: 'face' }).center.toArray()).toEqual([0, 0.8, 0.2]);
    model.remove(left, right);
    const fromHead = resolveFaceCenter(model, { name: 'face' });
    expect(fromHead.center.y).toBe(0.6); expect(fromHead.center.z).toBeCloseTo(0.08 * 2 / 1.8);
    model.remove(head);
    expect(resolveFaceCenter(model, { name: 'face' }).center.y).toBeCloseTo(0.8);
  });
});
