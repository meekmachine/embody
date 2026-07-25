import { Box3, BufferAttribute, BufferGeometry, Group, Mesh, Scene } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { applyCharacterModelTransform, disposeCharacterModel } from './modelLoader';
import { createCharacterHost } from './characterHost';

describe('applyCharacterModelTransform', () => {
  it('applies offset, rotation degrees, uniform scale, and then ground clearance', () => {
    const geometry = new BufferGeometry();
    geometry.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([
        -1, -2, -1,
        1, -2, -1,
        1, 0, 1,
        -1, 0, 1,
      ]), 3),
    );
    const mesh = new Mesh(geometry);
    const model = new Group();
    model.add(mesh);

    applyCharacterModelTransform(model, {
      modelOffset: { x: 1, y: 0, z: -2 },
      modelRotation: { y: 90 },
      modelScale: 0.5,
      modelGroundClearance: 0.05,
    });

    expect(model.position.x).toBe(1);
    expect(model.position.z).toBe(-2);
    expect(model.rotation.y).toBeCloseTo(Math.PI / 2, 5);
    expect(model.scale.toArray()).toEqual([0.5, 0.5, 0.5]);

    model.updateMatrixWorld(true);
    const bounds = new Box3().setFromObject(model);
    expect(bounds.min.y).toBeGreaterThanOrEqual(0.05 - 1e-5);
    expect(bounds.max.y - bounds.min.y).toBeCloseTo(1, 5);
  });

  it('preserves authored scale when modelScale is omitted', () => {
    const model = new Group();
    model.scale.set(2, 3, 4);

    applyCharacterModelTransform(model, {
      modelOffset: { x: 1 },
    });

    expect(model.scale.toArray()).toEqual([2, 3, 4]);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'ignores invalid modelScale value %s',
    (modelScale) => {
      const model = new Group();
      model.scale.setScalar(2);

      applyCharacterModelTransform(model, { modelScale });

      expect(model.scale.toArray()).toEqual([2, 2, 2]);
    },
  );
});

describe('disposeCharacterModel', () => {
  it('removes the model from the scene and disposes mesh resources', () => {
    const scene = new Scene();
    const geometry = new BufferGeometry();
    const disposeGeometry = vi.fn();
    geometry.dispose = disposeGeometry;
    const material = { dispose: vi.fn() };
    const mesh = new Mesh(geometry, material as never);
    const model = new Group();
    model.add(mesh);
    scene.add(model);

    disposeCharacterModel(scene, model);

    expect(scene.children).not.toContain(model);
    expect(disposeGeometry).toHaveBeenCalledTimes(1);
    expect(material.dispose).toHaveBeenCalledTimes(1);
  });
});

describe('createCharacterHost validation', () => {
  it('requires a container and modelUrl', async () => {
    await expect(
      createCharacterHost({
        container: null as never,
        character: { modelUrl: '/x.glb' },
      }),
    ).rejects.toThrow(/container HTMLElement/);

    await expect(
      createCharacterHost({
        container: {} as HTMLElement,
        character: { modelUrl: '' },
      }),
    ).rejects.toThrow(/modelUrl/);
  });
});
