import { Group, PerspectiveCamera, Scene } from 'three';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CharacterModelLoadResult } from '../../model';
import type { CharacterSceneRenderer, ReadyDefaultCharacterScene } from '../../scene';
import { createCharacterHost } from '../../characterHost';

const acquisition = vi.hoisted(() => ({
  load: vi.fn(), scene: vi.fn(), release: vi.fn(), engines: [] as Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }>,
  prepare: vi.fn(), cancelPreparation: undefined as (() => void) | undefined, controllerDisposed: vi.fn(),
}));
vi.mock('@lovelace_lol/embody/wasm', () => ({ initEmbodyCore: async () => ({}) }));
vi.mock('../../model', () => ({
  loadCharacterModel: (...args: unknown[]) => acquisition.load(...args),
  applyCharacterModelTransform: vi.fn(),
  disposeCharacterModel: (scene: Scene | null, model: Group) => { scene?.remove(model); acquisition.release(model); },
}));
vi.mock('../../scene', () => ({ createDefaultCharacterSceneAsync: (...args: unknown[]) => acquisition.scene(...args) }));
vi.mock('../../character', () => ({
  Embody: class {
    start = vi.fn(); stop = vi.fn(); dispose = vi.fn(); onReady = vi.fn();
    constructor() { acquisition.engines.push(this); }
  },
}));
// These doubles isolate acquisition and disposal. Native mixer behavior is
// covered separately; the lifecycle must also settle without another frame.
vi.mock('../ThreeAnnotationController', () => ({
  ThreeAnnotationController: class {
    setModel = vi.fn(); focusFullBody = vi.fn(async () => {});
    prepareModelForRender = (...args: unknown[]) => acquisition.prepare(...args);
    dispose() { acquisition.controllerDisposed(); acquisition.cancelPreparation?.(); }
  },
}));

function model(): CharacterModelLoadResult { return { model: new Group(), meshes: [], animations: [], gltf: null }; }
function scene() {
  const state = {
    scene: new Scene(), camera: new PerspectiveCamera(), backend: 'webgl' as const,
    renderer: { domElement: {} } as CharacterSceneRenderer,
    resize: vi.fn(), dispose: vi.fn(async () => {}), lighting: {},
    rendering: {
      releaseSceneResources: vi.fn(async (release: () => void) => release()),
      getSnapshot: () => ({ renderer: state.renderer, backend: state.backend, status: 'ready' }),
    },
  };
  return state;
}
const container = {} as HTMLElement;

beforeEach(() => {
  vi.clearAllMocks(); acquisition.engines.length = 0; acquisition.cancelPreparation = undefined;
  acquisition.prepare.mockResolvedValue(undefined);
});

describe('character host acquisition and disposal', () => {
  it('releases an acquired model when creation is aborted before scene acquisition', async () => {
    const signal = new AbortController();
    const loaded = model();
    acquisition.load.mockImplementationOnce(async () => { signal.abort(); return loaded; });
    await expect(createCharacterHost({ container, character: { modelUrl: 'first.glb' }, signal: signal.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(acquisition.scene).not.toHaveBeenCalled();
    expect(acquisition.release).toHaveBeenCalledOnce();
    expect(acquisition.release).toHaveBeenCalledWith(loaded.model);
  });

  it('drains borrowed rendering before releasing the model without disposing the external scene', async () => {
    const external = scene(); const loaded = model();
    let release!: () => void;
    let enterDrain!: () => void;
    const draining = new Promise<void>(resolve => { enterDrain = resolve; });
    external.rendering.releaseSceneResources.mockImplementationOnce(callback => new Promise<void>(resolve => {
      release = () => { callback(); resolve(); };
      enterDrain();
    }));
    acquisition.load.mockResolvedValueOnce(loaded);
    const host = await createCharacterHost({ container, character: { modelUrl: 'first.glb' }, external: external as unknown as ReadyDefaultCharacterScene });
    const disposing = host.dispose();
    await draining;
    expect(acquisition.release).not.toHaveBeenCalled();
    release(); await disposing;
    expect(acquisition.release).toHaveBeenCalledWith(loaded.model);
    expect(external.dispose).not.toHaveBeenCalled();
    expect(host.dispose()).toBe(disposing);
  });

  it('cancels a replacement waiting for a frame before awaiting its disposal', async () => {
    const owned = scene(); const first = model(); const second = model();
    acquisition.scene.mockResolvedValueOnce(owned);
    acquisition.load.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const host = await createCharacterHost({ container, character: { modelUrl: 'first.glb' }, autoFrame: false });
    let entered!: () => void;
    const preparing = new Promise<void>(resolve => { entered = resolve; });
    acquisition.prepare.mockImplementationOnce(() => new Promise<void>((_, reject) => {
      acquisition.cancelPreparation = () => reject(new Error('preparation cancelled'));
      entered();
    }));
    const replacement = host.setCharacter({ modelUrl: 'second.glb' });
    const rejected = expect(replacement).rejects.toThrow('preparation cancelled');
    await preparing;
    await host.dispose();
    await rejected;
    expect(acquisition.controllerDisposed).toHaveBeenCalledOnce();
    expect(acquisition.release.mock.calls.map(([value]) => value)).toEqual([second.model, first.model]);
    expect(acquisition.engines.every(engine => engine.dispose.mock.calls.length === 1)).toBe(true);
    expect(owned.dispose).toHaveBeenCalledOnce();
  });
});
