import { AnimationClip, BoxGeometry, Group, Mesh, MeshStandardMaterial, PerspectiveCamera, Scene } from 'three';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CharacterModelLoadResult } from '../../model';
import type { CharacterSceneRenderer, ReadyDefaultCharacterScene } from '../../scene';
import { createCharacterHost } from '../../characterHost';
import type { CharacterHostPreparation } from '../../characterHost';

const acquisition = vi.hoisted(() => ({
  load: vi.fn(), scene: vi.fn(), release: vi.fn(), engines: [] as Array<{
    start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn>;
    onReady: ReturnType<typeof vi.fn>; bindModel: ReturnType<typeof vi.fn>; config: unknown;
  }>,
  prepare: vi.fn(), cancelPreparation: undefined as (() => void) | undefined, controllerDisposed: vi.fn(),
  mappings: vi.fn(), regions: vi.fn(), frame: vi.fn(),
}));
vi.mock('@lovelace_lol/embody/wasm', () => ({ initEmbodyCore: async () => ({}) }));
vi.mock('../../model', () => ({
  loadCharacterModel: (...args: unknown[]) => acquisition.load(...args),
  applyCharacterModelTransform: vi.fn(),
  disposeCharacterModel: (scene: Scene | null, model: Group) => { scene?.remove(model); acquisition.release(model); },
}));
vi.mock('../../scene', () => ({ createDefaultCharacterSceneAsync: (...args: unknown[]) => acquisition.scene(...args) }));
vi.mock('../../authoring', () => ({ validateMappings: (...args: unknown[]) => acquisition.mappings(...args) }));
vi.mock('../../character', () => ({
  Embody: class {
    start = vi.fn(); stop = vi.fn(); dispose = vi.fn(); onReady = vi.fn(); bindModel = vi.fn();
    constructor(readonly config: unknown) { acquisition.engines.push(this); }
  },
}));
// These doubles isolate acquisition and disposal. Native mixer behavior is
// covered separately; the lifecycle must also settle without another frame.
vi.mock('../DPthreeCameraController', () => ({
  DPthreeCameraController: class {
    setModel = vi.fn(); focusFullBody = acquisition.frame;
    prepareRegionsForReveal = acquisition.regions;
    prepareModelForRender = (...args: unknown[]) => acquisition.prepare(...args);
    dispose() { acquisition.controllerDisposed(); acquisition.cancelPreparation?.(); }
  },
}));

function model(): CharacterModelLoadResult { return { model: new Group(), meshes: [], animations: [], gltf: null }; }
function scene() {
  let leases = 0;
  const state = {
    scene: new Scene(), camera: new PerspectiveCamera(), backend: 'webgl' as const,
    renderer: { domElement: {} } as CharacterSceneRenderer,
    resize: vi.fn(), dispose: vi.fn(async () => {}), setSceneSettings: vi.fn(), lighting: {},
    rendering: {
      releaseSceneResources: vi.fn(async (release: () => void) => { expect(leases).toBe(0); release(); }),
      getSnapshot: () => ({ renderer: state.renderer, backend: state.backend, status: 'ready' }),
      getSettings: () => ({ preference: 'webgl' }),
      setSettings: vi.fn(async () => {}),
      acquireRenderer: vi.fn(() => {
        leases += 1;
        return { renderer: state.renderer, release() { leases -= 1; } };
      }),
    },
  };
  return state;
}
const container = {} as HTMLElement;

beforeEach(() => {
  vi.clearAllMocks(); acquisition.engines.length = 0; acquisition.cancelPreparation = undefined;
  acquisition.prepare.mockResolvedValue(undefined);
  acquisition.frame.mockResolvedValue(undefined);
  acquisition.mappings.mockReturnValue({ corrections: [] });
});

describe('character host acquisition and disposal', () => {
  it('uses application asset delivery, prepares authored edits and respects saved camera configuration', async () => {
    const owned = scene(); const loaded = model();
    loaded.animations.push(new AnimationClip('Deferred', 1, []));
    acquisition.scene.mockResolvedValueOnce(owned);
    const delivery = vi.fn(async () => loaded);
    const prepare = vi.fn(({ engine, model: object }: CharacterHostPreparation) => {
      expect(engine).toBe(acquisition.engines[0]);
      expect(object.visible).toBe(false);
      expect(object.userData.embodyCharacterModel).toBe(true);
    });
    const annotationConfig = { characterId: 'custom', regions: [], defaultRegion: 'face', playIntroOnLoad: false };
    const host = await createCharacterHost({
      container, character: { modelUrl: 'authorized.glb', profile: {}, annotationConfig },
      embody: { profileMode: 'profile' }, registerEmbeddedAnimations: false,
      loadModel: delivery, prepareCharacter: prepare,
    });
    try {
      expect(delivery).toHaveBeenCalledWith('authorized.glb', expect.objectContaining({ signal: expect.any(AbortSignal) }));
      expect(acquisition.load).not.toHaveBeenCalled();
      expect(prepare).toHaveBeenCalledOnce();
      expect(acquisition.engines[0].onReady).toHaveBeenCalledWith({ model: loaded.model, meshes: [] });
      expect(acquisition.engines[0].bindModel).toHaveBeenCalledOnce();
      expect(acquisition.regions).toHaveBeenCalledWith(annotationConfig);
      expect(acquisition.frame).not.toHaveBeenCalled();
      expect(host.cameraController).not.toBeNull();
      expect(host.model.visible).toBe(true);
      expect(host.animations).toEqual(loaded.animations);
    } finally { await host.dispose(); }
  });

  it('applies Rust model mapping corrections to the exact profile and annotation input', async () => {
    const owned = scene(); const loaded = model();
    acquisition.scene.mockResolvedValueOnce(owned); acquisition.load.mockResolvedValueOnce(loaded);
    acquisition.mappings.mockReturnValueOnce({ corrections: [{ applied: true }], suggestedConfig: { boneNodes: { HEAD: 'ActualHead' } } });
    const host = await createCharacterHost({ container,
      character: { modelUrl: 'first.glb', profile: { boneNodes: { HEAD: 'old' } }, annotationConfig: { characterId: 'custom', regions: [] } },
      embody: { profileMode: 'profile' },
    });
    try {
      expect(acquisition.engines[0].config).toMatchObject({ profileMode: 'profile', profile: { boneNodes: { HEAD: 'ActualHead' } } });
      expect(acquisition.regions).toHaveBeenCalledWith(expect.objectContaining({ boneNodes: { HEAD: 'ActualHead' } }));
    } finally { await host.dispose(); }
  });

  it('releases a superseded delivered model and publishes only the latest replacement', async () => {
    const owned = scene(); const first = model(); const second = model(); const third = model();
    acquisition.scene.mockResolvedValueOnce(owned); acquisition.load.mockResolvedValueOnce(first);
    const host = await createCharacterHost({ container, character: { modelUrl: 'first.glb' }, autoFrame: false });
    let deliver!: (value: CharacterModelLoadResult) => void;
    let entered!: () => void;
    const loading = new Promise<void>(resolve => { entered = resolve; });
    acquisition.load.mockImplementationOnce(() => { entered(); return new Promise(resolve => { deliver = resolve; }); });
    acquisition.load.mockResolvedValueOnce(third);
    const obsolete = host.setCharacter({ modelUrl: 'second.glb' });
    const rejection = expect(obsolete).rejects.toMatchObject({ name: 'AbortError' });
    await loading;
    const latest = host.setCharacter({ modelUrl: 'third.glb' });
    deliver(second);
    await rejection;
    await latest;
    expect(host.model).toBe(third.model);
    expect(acquisition.release.mock.calls.map(([value]) => value)).toEqual([second.model, first.model]);
    await host.dispose();
  });

  it('cancels a replacement during authored preparation without revealing it', async () => {
    const owned = scene(); const first = model(); const second = model();
    acquisition.scene.mockResolvedValueOnce(owned); acquisition.load.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    let enter!: () => void; let resume!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const pause = new Promise<void>(resolve => { resume = resolve; });
    const host = await createCharacterHost({ container, character: { modelUrl: 'first.glb' }, autoFrame: false,
      prepareCharacter: async ({ model: value }) => { if (value === second.model) { enter(); await pause; } },
    });
    const signal = new AbortController();
    const replacing = host.setCharacter({ modelUrl: 'second.glb' }, undefined, signal.signal);
    const rejected = expect(replacing).rejects.toMatchObject({ name: 'AbortError' });
    await entered;
    signal.abort(); resume();
    await rejected;
    expect(host.model).toBe(first.model);
    expect(acquisition.engines[0].dispose).not.toHaveBeenCalled();
    expect(acquisition.release).toHaveBeenCalledWith(second.model);
    await host.dispose();
  });

  it('keeps construction cancellation separate from the returned host lifetime', async () => {
    const owned = scene(); const first = model(); const second = model();
    acquisition.scene.mockResolvedValueOnce(owned); acquisition.load.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const signal = new AbortController();
    const host = await createCharacterHost({ container, character: { modelUrl: 'first.glb', scene: { cameraFov: 60 } },
      signal: signal.signal, autoFrame: false });
    signal.abort();
    await host.setCharacter({ modelUrl: 'second.glb' });
    expect(host.model).toBe(second.model);
    expect(owned.setSceneSettings).toHaveBeenLastCalledWith({});
    await host.dispose();
  });

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


describe('character host palette background', () => {
  function coloredModel(color: string) {
    const value = model();
    const mesh = new Mesh(new BoxGeometry(), new MeshStandardMaterial({ color }));
    value.model.add(mesh);
    return { value, release() { mesh.geometry.dispose(); mesh.material.dispose(); } };
  }

  it('colors the mount for the selected character, switches palettes and restores host styling on disposal', async () => {
    const first = coloredModel('#cd765c'); const second = coloredModel('#26969c');
    const mount = { style: { background: 'original' } } as unknown as HTMLElement;
    acquisition.scene.mockResolvedValueOnce(scene());
    acquisition.load.mockResolvedValueOnce(first.value).mockResolvedValueOnce(second.value);
    const host = await createCharacterHost({ container: mount, character: { modelUrl: 'palette-coral.glb' } });
    try {
      const coralBackground = mount.style.background;
      expect(coralBackground).toContain('radial-gradient');
      await host.setCharacter({ modelUrl: 'palette-teal.glb' });
      expect(mount.style.background).toContain('radial-gradient');
      expect(mount.style.background).not.toBe(coralBackground);
      const tealBackground = mount.style.background;
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(mount.style.background).toBe(tealBackground);
    } finally { await host.dispose(); first.release(); second.release(); }
    expect(mount.style.background).toBe('original');
    // Deferred texture extraction must not repaint a disposed host.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mount.style.background).toBe('original');
  });

  it('does not repaint after disposal while texture extraction is pending', async () => {
    const loaded = coloredModel('#cd765c');
    const mount = { style: { background: 'original' } } as unknown as HTMLElement;
    acquisition.scene.mockResolvedValueOnce(scene()); acquisition.load.mockResolvedValueOnce(loaded.value);
    const host = await createCharacterHost({ container: mount, character: { modelUrl: 'dispose-palette.glb' } });
    await host.dispose();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mount.style.background).toBe('original');
    loaded.release();
  });

  it.each([{ background: '#123456' }, { background: null }, { type: 'void' as const }])(
    'preserves explicit scene appearance %j', async settings => {
      const loaded = coloredModel('#cd765c');
      const mount = { style: { background: 'original' } } as unknown as HTMLElement;
      acquisition.scene.mockResolvedValueOnce(scene()); acquisition.load.mockResolvedValueOnce(loaded.value);
      const host = await createCharacterHost({ container: mount, character: { modelUrl: 'explicit.glb', scene: settings } });
      try { expect(mount.style.background).toBe('original'); }
      finally { await host.dispose(); loaded.release(); }
    },
  );
});
