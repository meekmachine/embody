import { describe, expect, it } from 'vitest';
import {
  buildRegionDisplayOptions,
  filterCameraViewRegions,
  isRuntimeAnnotationRegionName,
} from '../DOMControls';

describe('buildRegionDisplayOptions', () => {
  it('keeps child regions visually nested under their parent labels', () => {
    const options = buildRegionDisplayOptions([
      { name: 'full_body' },
      { name: 'head', children: ['face', 'left_eye', 'right_eye', 'mouth'] },
      { name: 'face', parent: 'head' },
      { name: 'left_eye', parent: 'head' },
      { name: 'right_eye', parent: 'head' },
      { name: 'mouth', parent: 'head' },
    ]);

    expect(options).toEqual([
      { name: 'full_body', label: 'Full Body' },
      { name: 'head', label: 'Head' },
      { name: 'face', label: '-- Face' },
      { name: 'left_eye', label: '-- Left Eye' },
      { name: 'right_eye', label: '-- Right Eye' },
      { name: 'mouth', label: '-- Mouth' },
    ]);
  });

  it('treats regions with missing parents as top-level items', () => {
    const options = buildRegionDisplayOptions([
      { name: 'left_eye', parent: 'head' },
    ]);

    expect(options).toEqual([
      { name: 'left_eye', label: 'Left Eye' },
    ]);
  });

  it('excludes temporary runtime AU preview regions from the View dropdown', () => {
    const options = buildRegionDisplayOptions([
      { name: 'head' },
      { name: 'runtime:annotation:au:55:bone:CC_Base_Head' },
      { name: 'runtime:annotation:au:12:mesh:FaceMesh' },
      { name: 'mouth', parent: 'head' },
    ]);

    expect(options).toEqual([
      { name: 'head', label: 'Head' },
      { name: 'mouth', label: '-- Mouth' },
    ]);
  });
});

describe('filterCameraViewRegions', () => {
  it('identifies and strips runtime annotation region names', () => {
    expect(isRuntimeAnnotationRegionName('runtime:annotation:au:12:mesh:FaceMesh')).toBe(true);
    expect(isRuntimeAnnotationRegionName('head')).toBe(false);
    expect(filterCameraViewRegions([
      { name: 'head' },
      { name: 'runtime:annotation:au:12:mesh:FaceMesh' },
    ])).toEqual([{ name: 'head' }]);
  });
});
