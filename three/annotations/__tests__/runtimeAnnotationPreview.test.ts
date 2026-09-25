import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntimeAnnotationPreviewLifecycle } from '../runtimeAnnotationPreview';
import { inferRuntimeAnnotationPreviewSide } from '../runtimeAnnotationPreviewSide';

afterEach(() => vi.useRealTimers());

it('owns preview refresh, automatic end, cancellation, and reusable cleanup', () => {
  vi.useFakeTimers();
  const onPreviewStart = vi.fn(); const onPreviewEnd = vi.fn();
  let disabled = false;
  const lifecycle = createRuntimeAnnotationPreviewLifecycle({ getDisabled: () => disabled, onPreviewStart, onPreviewEnd });
  lifecycle.start(); vi.advanceTimersByTime(1000); lifecycle.start();
  expect(onPreviewStart).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1000); expect(lifecycle.isActive()).toBe(true);
  lifecycle.start(true); expect(onPreviewStart).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(1200); expect(lifecycle.isActive()).toBe(false); expect(onPreviewEnd).toHaveBeenCalledTimes(1);
  disabled = true; lifecycle.start(); expect(lifecycle.isActive()).toBe(false);
  disabled = false; lifecycle.start(); lifecycle.dispose();
  vi.runAllTimers(); expect(onPreviewEnd).toHaveBeenCalledTimes(2);
  lifecycle.start(); expect(lifecycle.isActive()).toBe(true); lifecycle.dispose();
});

it('uses fresh duration and callback values supplied by host getters', () => {
  vi.useFakeTimers(); let duration = 0;
  const onPreviewEnd = vi.fn();
  const lifecycle = createRuntimeAnnotationPreviewLifecycle({ getAutoClearMs: () => duration, onPreviewEnd });
  lifecycle.start(); vi.runAllTimers(); expect(lifecycle.isActive()).toBe(true);
  duration = 40; lifecycle.scheduleEnd(); vi.advanceTimersByTime(40); expect(onPreviewEnd).toHaveBeenCalledOnce();
});

describe('AU preview side inference', () => {
  it('honors mapped sides and avoids inventing a side for bilateral targets', () => {
    expect(inferRuntimeAnnotationPreviewSide(1, { auToMorphs: { 1: { left: ['L_Brow'] } } })).toBe('left');
    expect(inferRuntimeAnnotationPreviewSide(1, { auToMorphs: { 1: { left: ['L_Brow'], right: ['R_Brow'] } } })).toBeUndefined();
    expect(inferRuntimeAnnotationPreviewSide(2, { auToBones: { 2: [{ node: 'RightEye' }] } })).toBe('right');
    expect(inferRuntimeAnnotationPreviewSide(3, { auToMorphs: { 3: { center: ['Jaw'] } } })).toBe('center');
  });
});
