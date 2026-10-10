import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as wasm from '@lovelace_lol/embody/wasm';
import { createMarkerVisibilityLifecycle } from '../markerVisibilityLifecycle';
import { createRuntimeAnnotationPreviewLifecycle } from '../runtimeAnnotationPreview';
import { deferred } from './annotationDom';

// The eager setup imported the loader already. Isolate that module before
// replacing only its readiness boundary for this file's cold-start scenarios.
vi.hoisted(() => { vi.resetModules(); });
vi.mock('@lovelace_lol/embody/wasm', async importOriginal => {
  const actual = await importOriginal<typeof import('@lovelace_lol/embody/wasm')>();
  return {
    ...actual,
    initEmbodyCore: vi.fn(actual.initEmbodyCore),
    requireInitializedEmbodyCore: vi.fn(actual.requireInitializedEmbodyCore),
  };
});

// Load the real implementation before delaying availability in individual tests.
// Every lifecycle command and deadline still executes in the shipped Rust core.
const core = await wasm.initEmbodyCore();
let available: boolean;
let loading: ReturnType<typeof deferred<typeof core>>;
const cleanups: Array<() => void> = [];
function own<T extends { dispose(): void }>(lifecycle: T): T {
  cleanups.push(() => lifecycle.dispose());
  return lifecycle;
}

beforeEach(() => {
  vi.useFakeTimers();
  available = false;
  loading = deferred<typeof core>();
  vi.mocked(wasm.requireInitializedEmbodyCore).mockReset().mockImplementation(() => {
    if (!available) throw new Error('Core unavailable');
    return core;
  });
  vi.mocked(wasm.initEmbodyCore).mockReset().mockImplementation(() => loading.promise.then(value => {
    available = true;
    return value;
  }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  cleanups.splice(0).forEach(dispose => dispose());
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('retries a failed load on the next preview request and replays only new input', async () => {
  const onPreviewStart = vi.fn();
  const onPreviewEnd = vi.fn();
  const lifecycle = own(createRuntimeAnnotationPreviewLifecycle({ onPreviewStart, onPreviewEnd }));
  lifecycle.start(true);
  const failedReady = lifecycle.ready;
  const failure = new Error('Temporary download failure');
  loading.reject(failure);
  await expect(failedReady).rejects.toBe(failure);
  expect(onPreviewStart).not.toHaveBeenCalled();

  loading = deferred<typeof core>();
  lifecycle.start();
  lifecycle.scheduleEnd();
  expect(lifecycle.ready).not.toBe(failedReady);
  expect(wasm.initEmbodyCore).toHaveBeenCalledTimes(2);
  loading.resolve(core);
  await lifecycle.ready;
  expect(onPreviewStart).toHaveBeenCalledOnce();
  expect(lifecycle.isActive()).toBe(true);
  vi.advanceTimersByTime(1200);
  expect(onPreviewEnd).toHaveBeenCalledOnce();
  expect(lifecycle.isActive()).toBe(false);
});

it('uses a shared core recovered by a scene without starting another load', async () => {
  const controller = { setMarkersVisible: vi.fn(), setMarkerStyle: vi.fn() };
  const lifecycle = own(createMarkerVisibilityLifecycle(() => controller));
  lifecycle.showForCharacterLoad();
  loading.reject(new Error('Temporary download failure'));
  await expect(lifecycle.ready).rejects.toThrow('Temporary download failure');

  // A different scene has completed its retry of the shared Wasm loader.
  available = true;
  lifecycle.setManualVisibility(true);
  await lifecycle.ready;
  expect(wasm.initEmbodyCore).toHaveBeenCalledOnce();
  expect(controller.setMarkersVisible).toHaveBeenCalledExactlyOnceWith(true);
  expect(controller.setMarkerStyle).not.toHaveBeenCalled();
  vi.advanceTimersByTime(10_000);
  expect(controller.setMarkersVisible).toHaveBeenCalledOnce();
});

it('cancels queued preview and reveal callbacks when disposed before readiness', async () => {
  const onPreviewStart = vi.fn();
  const onPreviewEnd = vi.fn();
  const preview = own(createRuntimeAnnotationPreviewLifecycle({ onPreviewStart, onPreviewEnd }));
  const controller = { setMarkersVisible: vi.fn(), setMarkerStyle: vi.fn() };
  const visibility = own(createMarkerVisibilityLifecycle(() => controller));
  preview.start();
  visibility.showForCharacterLoad({ markerStyle: 'html' });
  preview.dispose();
  visibility.dispose();
  loading.resolve(core);
  await Promise.all([preview.ready, visibility.ready]);
  vi.advanceTimersByTime(10_000);
  expect(onPreviewStart).not.toHaveBeenCalled();
  expect(onPreviewEnd).not.toHaveBeenCalled();
  expect(controller.setMarkersVisible).not.toHaveBeenCalled();
  expect(controller.setMarkerStyle).not.toHaveBeenCalled();
  expect(preview.isActive()).toBe(false);
});

it('accepts fresh commands after pre-readiness cleanup without replaying retired input', async () => {
  const onPreviewStart = vi.fn();
  const onPreviewEnd = vi.fn();
  const lifecycle = own(createRuntimeAnnotationPreviewLifecycle({ onPreviewStart, onPreviewEnd }));
  lifecycle.start(true);
  lifecycle.dispose();
  lifecycle.start();
  loading.resolve(core);
  await lifecycle.ready;
  expect(onPreviewStart).toHaveBeenCalledOnce();
  lifecycle.dispose();
  expect(onPreviewEnd).toHaveBeenCalledOnce();
  lifecycle.start();
  expect(onPreviewStart).toHaveBeenCalledTimes(2);
  expect(wasm.initEmbodyCore).toHaveBeenCalledOnce();
});

it('lets a preview-start callback cancel the remaining queued commands', async () => {
  const onPreviewEnd = vi.fn();
  const onPreviewStart = vi.fn((): void => lifecycle.dispose());
  const lifecycle = own(createRuntimeAnnotationPreviewLifecycle({ onPreviewStart, onPreviewEnd }));
  lifecycle.start();
  lifecycle.start(true);
  loading.resolve(core);
  await lifecycle.ready;
  expect(onPreviewStart).toHaveBeenCalledOnce();
  expect(onPreviewEnd).toHaveBeenCalledOnce();
  expect(lifecycle.isActive()).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
