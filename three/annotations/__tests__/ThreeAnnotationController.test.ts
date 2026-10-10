import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThreeAnnotationController } from '../ThreeAnnotationController';
import type { ThreeAnnotationControllerConfig } from '../types';
import { deferred, installAnnotationDom } from './annotationDom';

const controllers: ThreeAnnotationController[] = [];
afterEach(() => { controllers.splice(0).forEach(controller => controller.dispose()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function fixture(options: Partial<ThreeAnnotationControllerConfig> = {}) {
  const dom = installAnnotationDom();
  const camera = new THREE.PerspectiveCamera(35, 4 / 3); const scene = new THREE.Scene();
  const controller = new ThreeAnnotationController({ camera, scene, domElement: dom.domElement, showDOMControls: false, ...options });
  controllers.push(controller);
  const model = new THREE.Group(); const body = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 0.4)); body.name = 'Body'; model.add(body);
  const bone = new THREE.Bone(); bone.name = 'Head'; bone.position.set(0, 0.8, 0); model.add(bone);
  controller.setModel(model);
  return { ...dom, controller, model, bone, camera, scene };
}
describe('Rust-owned annotation controller contract', () => {
  it.each(['3d', 'html'] as const)('builds deferred %s markers on first reveal and reuses them across visibility changes', style => {
    const { controller, scene } = fixture();
    const markerObjects = () => {
      const objects: THREE.Object3D[] = [];
      scene.traverse(object => { if (object.userData.annotationId !== undefined) objects.push(object); });
      return objects;
    };
    controller.prepareRegionsForReveal({ characterId: 'deferred', markerStyle: style, regions: [{
      name: 'saved', markerAnchor: { type: 'point', position: { x: 0, y: 0.8, z: 0.3 } },
    }] });
    expect(controller.getMarkerPosition('saved')).toBeNull();
    expect(markerObjects()).toEqual([]);
    controller.setMarkersVisible(false);
    expect(markerObjects()).toEqual([]);

    controller.setMarkersVisible(true);
    expect(controller.getMarkerPosition('saved')).toEqual({ x: 0, y: expect.closeTo(0.8), z: expect.closeTo(0.3) });
    const builtObjects = markerObjects();
    expect(builtObjects.length).toBeGreaterThan(0);
    controller.setMarkersVisible(false);
    controller.setMarkersVisible(true);
    const revealedObjects = markerObjects();
    expect(revealedObjects).toHaveLength(builtObjects.length);
    revealedObjects.forEach((object, index) => expect(object).toBe(builtObjects[index]));
  });
  it('builds the replacement character regions on their first reveal', () => {
    const { controller } = fixture();
    const regions = (name: string) => [{ name, markerAnchor: { type: 'point' as const, position: { x: 0, y: 0.8, z: 0.3 } } }];
    controller.prepareRegionsForReveal({ characterId: 'first', regions: regions('old') });
    controller.setMarkersVisible(true);
    expect(controller.getMarkerPosition('old')).not.toBeNull();
    controller.setMarkersVisible(false);
    controller.setModel(new THREE.Group());
    controller.prepareRegionsForReveal({ characterId: 'second', regions: regions('new') });
    expect(controller.getMarkerPosition('old')).toBeNull();
    expect(controller.getMarkerPosition('new')).toBeNull();
    controller.setMarkersVisible(true);
    expect(controller.getMarkerPosition('new')).toEqual({ x: 0, y: expect.closeTo(0.8), z: expect.closeTo(0.3) });
  });
  it('frames a point independently of its marker and mirrors exact immediate poses into Three', async () => {
    const { controller, camera } = fixture();
    controller.prepareRegionsForReveal({ characterId: 'point', regions: [{ name: 'eye', markerAnchor: { type: 'point', position: { x: -0.2, y: 0.7, z: 0.3 } }, focusTarget: { type: 'point', position: { x: 0.3, y: 0.6, z: 0.2 } } }] });
    await controller.loadMarkersForCurrentRegions();
    await controller.focusRegion('eye', 0);
    expect(controller.controls.target.toArray()).toEqual([expect.closeTo(0.3), expect.closeTo(0.6), expect.closeTo(0.2)]);
    expect(controller.getMarkerPosition('eye')).toEqual({ x: expect.closeTo(-0.2), y: expect.closeTo(0.7), z: expect.closeTo(0.3) });
    expect(camera.position.toArray()).toEqual(controller.getCameraState().position);
    expect(controller.getCurrentRegion()).toBe('eye');
  });
  it('keeps profile snapshots stable through camera and selection updates, then replaces them for authored edits', async () => {
    const { controller } = fixture();
    controller.prepareRegionsForReveal({ characterId: 'stable', regions: [{ name: 'head', bones: ['Head'] }] });
    const first = controller.getCharacterConfig();
    expect(controller.getCharacterConfig()).toBe(first);
    controller.setCurrentRegion('head');
    controller.setMarkersVisible(true);
    await controller.animateToCameraState({ position: [1, 2, 3], target: [0, 1, 0] }, 0);
    expect(controller.getCharacterConfig()).toBe(first);
    controller.updateAnnotationRegion('head', { label: 'Renamed' });
    const changed = controller.getCharacterConfig();
    expect(changed).not.toBe(first);
    expect(changed?.regions?.[0].label).toBe('Renamed');
    expect(controller.getCharacterConfig()).toBe(changed);
    controller.clearModel();
    expect(controller.getModel()).toBeNull();
    expect(controller.getCharacterConfig()).toBeNull();
  });
  it('settles superseded, zero-duration, and character-cancelled flights', async () => {
    const { controller, frames } = fixture();
    const first = controller.animateToCameraState({ position: [1, 2, 3], target: [0, 0, 0] }, 1000);
    expect(frames.size).toBe(1);
    await controller.animateToCameraState({ position: [3, 2, 1], target: [0, 1, 0] }, 0); await first;
    expect(controller.getCameraState().position).toEqual([3, 2, 1]);
    const second = controller.focusFullBody(1000); controller.setModel(new THREE.Group()); await second;
    const third = controller.animateToCameraState({ position: [5, 4, 3], target: [0, 0, 0] }, 1000); controller.dispose(); await third;
    expect(frames.size).toBe(0);
  });
  it('transports raw gestures to Rust and honors external control disabling', () => {
    const { controller, host } = fixture({ enableDamping: false });
    const wheel = () => host.dispatchEvent(Object.assign(new Event('wheel'), { deltaY: 100, deltaMode: 0 }));
    const initial = controller.getCameraState(); wheel();
    expect(controller.getCameraState().position).not.toEqual(initial.position);
    controller.controls.enabled = false; const disabled = controller.getCameraState(); wheel();
    expect(controller.getCameraState().position).toEqual(disabled.position);
  });
  it('keeps host metadata borrowed while runtime AU regions and authored edits live in Rust', () => {
    const { controller } = fixture(); const metadata: Record<string, unknown> = {}; metadata.self = metadata;
    const config = { characterId: 'metadata', regions: [{ name: 'saved', meshes: ['Body'] }], hostData: metadata };
    controller.prepareRegionsForReveal(config);
    const profile = { auToBones: { '1': [{ node: 'Head' }] }, hostData: metadata };
    const [summary] = controller.showRuntimeAUAnnotations(1, profile);
    expect(summary.name).toBe('runtime:annotation:au:1:bone:Head');
    expect(controller.getAnnotationRegion(summary.name)?.focusTarget).toMatchObject({ type: 'bone', bones: ['Head'], paddingFactor: expect.closeTo(0.8) });
    expect((controller.getCharacterConfig() as typeof config).hostData).toBe(metadata);
    controller.updateAnnotationRegion('saved', { label: 'Authored' });
    const exposed = controller.getAnnotationRegions(); exposed[0].label = 'Outside mutation';
    expect(controller.getAnnotationRegion('saved')?.label).toBe('Authored');
    expect(controller.clearRuntimeAnnotations()).toEqual([summary.name]);
    expect(controller.getRegionNames()).toEqual(['saved']);
  });
});
describe('native renderer lifecycle', () => {
  function rendererFixture() {
    let loop: (() => void) | null = null;
    const renderer = { setAnimationLoop: vi.fn((callback: (() => void) | null) => { loop = callback; }), setSize: vi.fn(), setPixelRatio: vi.fn(), render: vi.fn() };
    const renderFrame = vi.fn<() => void | Promise<void>>(); const onRenderError = vi.fn();
    const f = fixture({ renderer: renderer as unknown as THREE.WebGLRenderer, renderFrame, onRenderError });
    return { ...f, renderer, renderFrame, onRenderError, tick: () => loop?.() };
  }
  it('uses the host renderer loop and skips overlapping async frames', async () => {
    const f = rendererFixture(); const pending = deferred(); f.renderFrame.mockReturnValueOnce(pending.promise);
    f.tick(); f.tick(); expect(f.renderFrame).toHaveBeenCalledOnce();
    expect(f.renderFrame).toHaveBeenCalledWith(f.renderer, f.scene, f.camera);
    expect(f.frames.size).toBe(0); pending.resolve(); await pending.promise; f.tick();
    expect(f.renderFrame).toHaveBeenCalledTimes(2);
  });
  it.each(['throw', 'reject'] as const)('stops the loop on a host %s and reports the original error once', async mode => {
    const f = rendererFixture(); const failure = new Error('renderer failed');
    f.renderFrame.mockImplementationOnce(() => { if (mode === 'throw') throw failure; return Promise.reject(failure); });
    f.tick(); await Promise.resolve(); f.tick();
    expect(f.onRenderError).toHaveBeenCalledExactlyOnceWith(failure);
    expect(f.renderer.setAnimationLoop).toHaveBeenLastCalledWith(null);
  });
  it('consumes a late rejected host frame after disposal', async () => {
    const f = rendererFixture(); const pending = deferred(); f.renderFrame.mockReturnValueOnce(pending.promise);
    f.tick(); f.controller.dispose(); pending.reject(new Error('late')); await Promise.resolve();
    expect(f.onRenderError).not.toHaveBeenCalled();
  });
});
