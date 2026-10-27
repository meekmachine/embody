import { describe, expect, it } from 'vitest';
import { buildMappedBoneInfo } from '../../../editor/SkeletonOverlay';

describe('buildMappedBoneInfo', () => {
  it('retains all semantic keys that resolve to the same rendered bone row', () => {
    const info = buildMappedBoneInfo({
      bonePrefix: 'CC_Base_',
      boneNodes: {
        EYE_BOTH: 'Eye',
        EYE_L: 'Eye',
        EYE_R: 'Eye',
        HEAD: 'Head',
      },
    });

    expect(info.mappedNames.has('CC_Base_Eye')).toBe(true);
    expect(info.semanticKeyMap.get('CC_Base_Eye')).toBe('EYE_BOTH');
    expect(info.semanticKeysMap.get('CC_Base_Eye')).toEqual(['EYE_BOTH', 'EYE_L', 'EYE_R']);
    expect(info.semanticKeysMap.get('Eye')).toEqual(['EYE_BOTH', 'EYE_L', 'EYE_R']);
  });

  it('resolves mapped bone info against runtime numeric suffixes when actual bone names are provided', () => {
    const info = buildMappedBoneInfo({
      bonePrefix: 'CC_Base_',
      boneNodes: {
        HEAD: 'Head',
        EYE_L: 'L_Eye',
      },
    }, [
      'CC_Base_Head_038',
      'CC_Base_L_Eye_046',
      'CC_Base_Hip_02',
    ]);

    expect(info.mappedNames.has('CC_Base_Head_038')).toBe(true);
    expect(info.mappedNames.has('CC_Base_L_Eye_046')).toBe(true);
    expect(info.semanticKeyMap.get('CC_Base_Head_038')).toBe('HEAD');
    expect(info.semanticKeyMap.get('CC_Base_L_Eye_046')).toBe('EYE_L');
  });
});
