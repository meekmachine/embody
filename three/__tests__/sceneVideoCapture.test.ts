import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireCharacterSceneVideoCapture, endCharacterSceneVideoCaptures } from '../sceneVideoCapture';
import type { CharacterSceneRenderingController, CharacterSceneRenderingSnapshot } from '../scene';

const observers: FakeObserver[] = [];
class FakeObserver {
  observe = vi.fn();
  disconnect = vi.fn();
  constructor(readonly callback: MutationCallback) { observers.push(this); }
  changed() { this.callback([], this as unknown as MutationObserver); }
}

function fixture() {
  const track = Object.assign(new EventTarget(), { readyState: 'live', kind: 'video', stop: vi.fn() });
  track.stop.mockImplementation(() => { track.readyState = 'ended'; });
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
  const canvas = { width: 1280, height: 720, captureStream: vi.fn(() => stream) };
  const renderer = { domElement: canvas, render: vi.fn(), setSize: vi.fn(), setAnimationLoop: vi.fn() };
  let snapshot = { settings: { preference: 'webgl' }, status: 'ready', error: null, backend: 'webgl', renderer } as unknown as CharacterSceneRenderingSnapshot;
  const listeners = new Set<(value: CharacterSceneRenderingSnapshot) => void>();
  const release = vi.fn(), unsubscribe = vi.fn();
  const rendering = {
    acquireRenderer: vi.fn(() => ({ renderer, release })), getSnapshot: () => snapshot,
    subscribe: vi.fn((listener: (value: CharacterSceneRenderingSnapshot) => void) => {
      listeners.add(listener); listener(snapshot);
      return () => { unsubscribe(); listeners.delete(listener); };
    }),
  } as unknown as CharacterSceneRenderingController;
  return { track, stream, canvas, renderer, release, unsubscribe, rendering,
    publish(change: Partial<CharacterSceneRenderingSnapshot>) {
      snapshot = { ...snapshot, ...change } as CharacterSceneRenderingSnapshot;
      for (const listener of listeners) listener(snapshot);
    },
  };
}

beforeEach(() => { observers.length = 0; vi.stubGlobal('MutationObserver', FakeObserver); });
afterEach(() => vi.unstubAllGlobals());

describe('managed character canvas video capture', () => {
  it('borrows the renderer, captures its existing canvas and releases each owned resource once', () => {
    const f = fixture(), ended = vi.fn(); f.track.addEventListener('ended', ended);
    const capture = acquireCharacterSceneVideoCapture(f.rendering, { fps: 24 });
    expect(capture.stream).toBe(f.stream); expect(f.canvas.captureStream).toHaveBeenCalledWith(24);
    expect(f.release).not.toHaveBeenCalled();
    capture.release(); capture.release();
    expect(f.track.stop).toHaveBeenCalledOnce(); expect(f.release).toHaveBeenCalledOnce();
    expect(f.unsubscribe).toHaveBeenCalledOnce(); expect(observers[0].disconnect).toHaveBeenCalledOnce();
    expect(ended).not.toHaveBeenCalled();
    expect(f.renderer.render).not.toHaveBeenCalled(); expect(f.renderer.setSize).not.toHaveBeenCalled(); expect(f.renderer.setAnimationLoop).not.toHaveBeenCalled();
  });

  it.each(['switching', 'lost', 'disposed'] as const)('ends capture synchronously on owner %s before notifying consumers', status => {
    const f = fixture(), ended = vi.fn(() => expect(f.release).toHaveBeenCalledOnce());
    f.track.addEventListener('ended', ended);
    const capture = acquireCharacterSceneVideoCapture(f.rendering);
    f.publish({ status });
    expect(f.track.stop).toHaveBeenCalledOnce(); expect(ended).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce(); capture.release(); expect(f.release).toHaveBeenCalledOnce();
  });

  it('ends capture when a different renderer becomes active', () => {
    const f = fixture(); const capture = acquireCharacterSceneVideoCapture(f.rendering);
    f.publish({ renderer: { domElement: {} } as never });
    expect(f.release).toHaveBeenCalledOnce(); expect(f.track.stop).toHaveBeenCalledOnce(); capture.release();
  });

  it('does not unregister a newer capture when an older handle is released twice', () => {
    const f = fixture(); const first = acquireCharacterSceneVideoCapture(f.rendering); first.release();
    f.track.readyState = 'live';
    const second = acquireCharacterSceneVideoCapture(f.rendering);
    first.release(); endCharacterSceneVideoCaptures(f.rendering);
    expect(f.release).toHaveBeenCalledTimes(2); expect(f.track.readyState).toBe('ended'); second.release();
  });

  it('ignores same-size mutations and terminates on a width or height change', () => {
    const f = fixture(), ended = vi.fn(); f.track.addEventListener('ended', ended);
    acquireCharacterSceneVideoCapture(f.rendering);
    observers[0].changed(); expect(f.release).not.toHaveBeenCalled();
    f.canvas.width = 640; observers[0].changed();
    expect(f.release).toHaveBeenCalledOnce(); expect(ended).toHaveBeenCalledOnce();
  });

  it('releases on a native ended event without dispatching another ended event', () => {
    const f = fixture(), ended = vi.fn(); f.track.addEventListener('ended', ended);
    const capture = acquireCharacterSceneVideoCapture(f.rendering);
    f.track.readyState = 'ended'; f.track.dispatchEvent(new Event('ended'));
    expect(ended).toHaveBeenCalledOnce(); expect(f.release).toHaveBeenCalledOnce(); capture.release();
  });

  it('cleans up a synchronous invalidation from subscribe before its disposer is returned', () => {
    const f = fixture();
    vi.mocked(f.rendering.subscribe).mockImplementation(listener => {
      listener({ ...f.rendering.getSnapshot(), status: 'switching' }); return f.unsubscribe;
    });
    expect(() => acquireCharacterSceneVideoCapture(f.rendering)).toThrow('renderer changed');
    expect(f.track.stop).toHaveBeenCalledOnce(); expect(f.release).toHaveBeenCalledOnce(); expect(f.unsubscribe).toHaveBeenCalledOnce();
  });

  it('releases the lease when native canvas capture throws', () => {
    const f = fixture(); f.canvas.captureStream.mockImplementation(() => { throw new Error('capture failed'); });
    expect(() => acquireCharacterSceneVideoCapture(f.rendering)).toThrow('capture failed');
    expect(f.release).toHaveBeenCalledOnce(); expect(f.track.stop).not.toHaveBeenCalled();
  });

  it('cleans up tracks, subscriptions and lease if size observation throws', () => {
    const f = fixture();
    vi.stubGlobal('MutationObserver', class extends FakeObserver { observe = vi.fn(() => { throw new Error('observer failed'); }); });
    expect(() => acquireCharacterSceneVideoCapture(f.rendering)).toThrow('observer failed');
    expect(f.track.stop).toHaveBeenCalledOnce(); expect(f.release).toHaveBeenCalledOnce(); expect(f.unsubscribe).toHaveBeenCalledOnce(); expect(observers[0].disconnect).toHaveBeenCalledOnce();
  });

  it.each([0, 61, NaN])('rejects invalid frame rate %s before borrowing a renderer', fps => {
    const f = fixture(); expect(() => acquireCharacterSceneVideoCapture(f.rendering, { fps })).toThrow('frame rate');
    expect(f.rendering.acquireRenderer).not.toHaveBeenCalled();
  });
});
