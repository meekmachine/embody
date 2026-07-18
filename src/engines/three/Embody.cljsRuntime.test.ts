import { describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import { createAnimationRuntime } from '../../cljs';
import { BONE_AU_TO_BINDINGS, COMPOSITE_ROTATIONS } from '../../presets/cc4';
import { Embody } from './Embody';

describe('Embody animation runtime factory', () => {
  it('routes dynamic clip handles through the runtime while Three applies the clip', async () => {
    const model = new Object3D();
    const leftEye = new Object3D();
    leftEye.name = 'CC_Base_L_Eye';
    model.add(leftEye);

    const engine = new Embody({
      animationRuntimeFactory: createAnimationRuntime,
      profile: {
        auToMorphs: {},
        auToBones: BONE_AU_TO_BINDINGS,
        boneNodes: { EYE_L: 'CC_Base_L_Eye' },
        morphToMesh: {},
        visemeKeys: [],
        compositeRotations: COMPOSITE_ROTATIONS,
      },
    });

    engine.onReady({ meshes: [], model });

    const handle = engine.buildClip(
      'runtime-eye-clip',
      {
        65: [
          { time: 0, intensity: 0 },
          { time: 0.5, intensity: 1 },
          { time: 1, intensity: 0 },
        ],
      },
      { loopMode: 'once', source: 'snippet' }
    );

    expect(handle).toBeTruthy();
    if (!handle) throw new Error('Expected Embody.buildClip to return a runtime handle');
    expect(handle.actionId).toBeTruthy();

    const events: unknown[] = [];
    handle.subscribe?.((event: unknown) => events.push(event));

    engine.update(0.5);
    expect(leftEye.quaternion.w).not.toBe(1);

    engine.update(0.5);
    await handle.finished;

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'keyframe', clipName: 'runtime-eye-clip', currentTime: 0.5 }),
      expect.objectContaining({ type: 'completed', clipName: 'runtime-eye-clip' }),
    ]));
  });
});
