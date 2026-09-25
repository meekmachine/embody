import { describe, expect, it } from 'vitest';
import { pickContinuumAnnotationAuId } from '../runtimeAnnotationPreviewSide';

describe('pickContinuumAnnotationAuId', () => {
  it('follows the active continuum side when not sticky', () => {
    expect(pickContinuumAnnotationAuId(-0.4, 55, 56, null)).toBe(55);
    expect(pickContinuumAnnotationAuId(0.4, 55, 56, null)).toBe(56);
    expect(pickContinuumAnnotationAuId(0, 55, 56, null)).toBe(55);
  });

  it('keeps the sticky AU while crossing zero', () => {
    expect(pickContinuumAnnotationAuId(-0.01, 55, 56, 55)).toBe(55);
    expect(pickContinuumAnnotationAuId(0, 55, 56, 55)).toBe(55);
    expect(pickContinuumAnnotationAuId(0.8, 55, 56, 55)).toBe(55);
    expect(pickContinuumAnnotationAuId(-0.8, 55, 56, 56)).toBe(56);
  });
});
