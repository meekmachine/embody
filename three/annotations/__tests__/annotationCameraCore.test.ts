import { beforeEach, describe, expect, it, vi } from 'vitest';

const createCore = vi.hoisted(() => vi.fn());
vi.mock('../adapter', () => ({ createRustAnnotationCameraCore: createCore }));

beforeEach(() => {
  vi.resetModules();
  createCore.mockReset();
});

describe('shared annotation camera core readiness', () => {
  it('shares one initialization and only exposes synchronous math once ready', async () => {
    let complete!: (core: object) => void;
    createCore.mockReturnValue(new Promise((resolve) => { complete = resolve; }));
    const { getAnnotationCameraCore, requireAnnotationCameraCore } = await import('../annotationCameraCore');
    const first = getAnnotationCameraCore();
    const second = getAnnotationCameraCore();
    expect(first).toBe(second);
    expect(createCore).toHaveBeenCalledOnce();
    expect(requireAnnotationCameraCore).toThrow('Await getAnnotationCameraCore()');

    const core = {};
    complete(core);
    expect(await first).toBe(core);
    expect(requireAnnotationCameraCore()).toBe(core);
    expect(await getAnnotationCameraCore()).toBe(core);
    expect(createCore).toHaveBeenCalledOnce();
  });

  it('allows a later load to retry a failed Wasm initialization', async () => {
    const core = {};
    createCore.mockRejectedValueOnce(new Error('Wasm unavailable')).mockResolvedValueOnce(core);
    const { getAnnotationCameraCore, requireAnnotationCameraCore } = await import('../annotationCameraCore');
    await expect(getAnnotationCameraCore()).rejects.toThrow('Wasm unavailable');
    expect(requireAnnotationCameraCore).toThrow('not ready');
    expect(await getAnnotationCameraCore()).toBe(core);
    expect(requireAnnotationCameraCore()).toBe(core);
    expect(createCore).toHaveBeenCalledTimes(2);
  });
});
