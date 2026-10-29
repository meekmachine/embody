import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { normalizeRenderableCharacterMorphAttributes, assertRenderableCharacterMorphAttributes } from '../../modelMorphLayout';

describe('renderable character morph attributes', () => {
  it('repairs missing neutral attributes and removes empty channels before render', () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(9), 3));
    geometry.morphTargetsRelative = true;
    geometry.morphAttributes.position = [
      new THREE.BufferAttribute(new Float32Array(9), 3),
      new THREE.BufferAttribute(new Float32Array(9), 3),
    ];
    geometry.morphAttributes.normal = [
      new THREE.BufferAttribute(new Float32Array(9), 3),
    ];
    geometry.morphAttributes.color = [];
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    mesh.name = 'CC_Base_Body_1';
    const model = new THREE.Group();
    model.add(mesh);

    const repairs = normalizeRenderableCharacterMorphAttributes(model);

    expect(repairs).toEqual([{
      meshName: 'CC_Base_Body_1',
      paddedChannels: { normal: 1 },
      removedEmptyChannels: ['color'],
      paddedInfluences: 0,
    }]);
    expect(geometry.morphAttributes.normal).toHaveLength(2);
    expect(Array.from(geometry.morphAttributes.normal[1].array)).toEqual(new Array(9).fill(0));
    expect(geometry.morphAttributes.color).toBeUndefined();
    expect(() => assertRenderableCharacterMorphAttributes(model)).not.toThrow();
    expect(normalizeRenderableCharacterMorphAttributes(model)).toEqual([]);
  });

  it('uses base geometry for a missing absolute morph target', () => {
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.morphTargetsRelative = false;
    geometry.morphAttributes.position = [
      new THREE.BufferAttribute(new Float32Array(9).fill(10), 3),
    ];
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    mesh.morphTargetInfluences = [0, 0];
    const model = new THREE.Group();
    model.add(mesh);

    normalizeRenderableCharacterMorphAttributes(model);

    expect(Array.from(geometry.morphAttributes.position[1].array)).toEqual(Array.from(positions));
    expect(() => assertRenderableCharacterMorphAttributes(model)).not.toThrow();
  });

  it('rejects morph attributes with unrecoverable vertex counts', () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
    geometry.morphAttributes.position = [
      new THREE.BufferAttribute(new Float32Array(6), 3),
    ];
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    const model = new THREE.Group();
    model.add(mesh);

    expect(() => normalizeRenderableCharacterMorphAttributes(model)).toThrow(
      /invalid morph position\[0\].*count=2.*expected count=3/,
    );
  });
});
