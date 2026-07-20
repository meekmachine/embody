import { describe, expect, it } from 'vitest';

import {
  TEMPLATE_SKELETON_FIT_METADATA_KIND,
  TEMPLATE_SKELETON_FIT_METADATA_VERSION,
  composeTemplateSkeletonFitTransform,
  isTemplateSkeletonFitStatus,
  validateTemplateSkeletonFitMetadata,
  type TemplateSkeletonFitMetadata,
} from './skeletonFit';

const validMetadata: TemplateSkeletonFitMetadata = {
  kind: TEMPLATE_SKELETON_FIT_METADATA_KIND,
  version: TEMPLATE_SKELETON_FIT_METADATA_VERSION,
  templateId: 'humanoid-basic',
  sourceCharacterId: 'character-1',
  verticalAxis: 'y',
  verticalAnchor: 'min',
  fit: {
    scale: 1.2,
    translation: { x: 0.1, y: 0.2, z: -0.1 },
    confidence: 0.75,
    meshHeight: 1.8,
    templateHeight: 1.5,
    crossAxisSpans: { x: 0.6, y: 1.8, z: 0.4 },
    status: 'estimated',
  },
  manualAdjustment: {
    scale: 1.05,
    translation: { x: 0.01, y: -0.02, z: 0.03 },
  },
};

describe('template skeleton fit contracts', () => {
  it('validates serializable fit metadata', () => {
    expect(validateTemplateSkeletonFitMetadata(validMetadata)).toEqual({ valid: true, errors: [] });
  });

  it('rejects unknown status and non-finite numeric metadata', () => {
    const result = validateTemplateSkeletonFitMetadata({
      ...validMetadata,
      fit: {
        ...validMetadata.fit,
        confidence: Number.NaN,
        status: 'animation-ready',
      },
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('fit.confidence must be a finite number between 0 and 1');
    expect(result.errors).toContain('fit.status must be one of: unfitted, estimated, manual-adjusted, invalid');
  });

  it('keeps fit metadata distinguishable from skinning or rig data', () => {
    expect(validateTemplateSkeletonFitMetadata({ ...validMetadata, kind: 'skin-weights' })).toEqual({
      valid: false,
      errors: ['kind must be "template-skeleton-fit"'],
    });
  });

  it('rejects unknown schema versions and empty identity fields', () => {
    const result = validateTemplateSkeletonFitMetadata({
      ...validMetadata,
      version: TEMPLATE_SKELETON_FIT_METADATA_VERSION + 1,
      templateId: '   ',
      sourceCharacterId: '',
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(`version must be ${TEMPLATE_SKELETON_FIT_METADATA_VERSION}`);
    expect(result.errors).toContain('templateId must be a non-empty string');
    expect(result.errors).toContain('sourceCharacterId must be a non-empty string');
  });

  it('composes solved fit transforms with manual adjustments', () => {
    expect(composeTemplateSkeletonFitTransform(validMetadata.fit, validMetadata.manualAdjustment)).toEqual({
      scale: 1.26,
      translation: { x: 0.11, y: 0.18000000000000002, z: -0.07 },
    });
  });

  it('recognizes stable status codes', () => {
    expect(isTemplateSkeletonFitStatus('manual-adjusted')).toBe(true);
    expect(isTemplateSkeletonFitStatus('skinned')).toBe(false);
  });
});
