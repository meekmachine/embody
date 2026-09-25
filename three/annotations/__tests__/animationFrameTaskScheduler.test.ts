import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnimationFrameTaskScheduler } from '../animationFrameTaskScheduler';

describe('AnimationFrameTaskScheduler', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('runs multiple animation tasks from one RAF callback', () => {
    const callbacks: FrameRequestCallback[] = [];
    const requestAnimationFrameMock = vi.fn((callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    });

    vi.stubGlobal('requestAnimationFrame', requestAnimationFrameMock);
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    const scheduler = new AnimationFrameTaskScheduler();
    const firstTask = vi.fn(() => false);
    const secondTask = vi.fn(() => false);

    scheduler.schedule('first', firstTask, false);
    scheduler.schedule('second', secondTask, false);

    expect(requestAnimationFrameMock).toHaveBeenCalledTimes(1);

    callbacks[0](16);

    expect(firstTask).toHaveBeenCalledWith(16);
    expect(secondTask).toHaveBeenCalledWith(16);
    expect(scheduler.size).toBe(0);
  });

  it('cancels the shared RAF when all pending tasks are removed', () => {
    const requestAnimationFrameMock = vi.fn(() => 42);
    const cancelAnimationFrameMock = vi.fn();

    vi.stubGlobal('requestAnimationFrame', requestAnimationFrameMock);
    vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrameMock);

    const scheduler = new AnimationFrameTaskScheduler();
    scheduler.schedule('task', () => true, false);
    scheduler.cancel('task');

    expect(cancelAnimationFrameMock).toHaveBeenCalledWith(42);
    expect(scheduler.size).toBe(0);
  });
});
