import { BoxGeometry, Float32BufferAttribute, Group, Mesh } from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { initEmbodyCore, extractModelData, getAUBoneBindingState, getAUBoneBindingStates, getPreset, resolveVisemeProfile, setAUMorphTargets, validateMappings } from '@lovelace_lol/embody';

beforeAll(async () => { await initEmbodyCore(); });

describe('Embody authoring API', () => {
  it('returns the same bone links in a batch without reading unrelated character assets', () => {
    const profile = getPreset('cc4');
    const ids = [12, 26, 51, 61, 1001, 9999];
    const expected = Object.fromEntries(ids.map(id => [id, getAUBoneBindingState(profile, id)]));
    Object.defineProperty(profile, 'authoredMorphs', {
      enumerable: true, get() { throw new Error('Vertex assets must not be serialized by a bone query'); },
    });
    Object.defineProperty(profile, 'importedBakedAnimations', {
      enumerable: true, get() { throw new Error('Saved clips must not be serialized by a bone query'); },
    });
    expect(getAUBoneBindingStates(profile, ids)).toEqual(expected);
    expect(getAUBoneBindingStates({}, [])).toEqual({});
  });

  it('keeps selected AU edits in Rust and leaves the source profile unchanged', () => {
    const original = getPreset('cc4');
    const before = JSON.stringify(original);
    const edited = setAUMorphTargets(original, 12, 'left', ['CustomSmile']);
    expect(edited.auToMorphs[12].left).toEqual(['CustomSmile']);
    expect(JSON.stringify(original)).toBe(before);
    expect(edited.auToBones).toEqual(original.auToBones);
  });

  it('preserves canonical routing indices when the stock viseme slots are reordered', () => {
    const profile = getPreset('cc4');
    const original = resolveVisemeProfile(profile);
    const reversed = resolveVisemeProfile({ ...profile, visemeSlots: [...profile.visemeSlots!].reverse().map((slot, order) => ({ ...slot, order })) });
    expect(reversed.routingMode).toBe('legacy');
    expect(reversed.canonicalSlotIndices).toEqual(original.visemeSlots.map((_, index) => original.visemeSlots.length - 1 - index));
    expect(reversed.canonicalSlotIndices!.map(index => reversed.visemeSlots[index].id)).toEqual(original.visemeSlots.map(slot => slot.id));
  });

  it('extracts real Three morph targets and validates mappings against the same names', () => {
    const model = new Group();
    const geometry = new BoxGeometry();
    const target = new Float32BufferAttribute(geometry.attributes.position.array.slice(), 3);
    target.name = 'CustomSmile'; geometry.morphAttributes.position = [target];
    const mesh = new Mesh(geometry); mesh.name = 'CustomFace'; model.add(mesh);
    const data = extractModelData(model, [mesh]);
    expect(data.morphNames).toContain('CustomSmile');
    expect(data.meshNames).toContain('CustomFace');
    const profile = { ...getPreset('cc4'), auToMorphs: { 12: { left: [], right: [], center: ['CustomSmile'] } }, auToBones: {}, visemeKeys: [], visemeSlots: [], visemeBindings: {}, morphToMesh: { face: ['CustomFace'] } };
    const report = validateMappings([mesh], { bones: [] }, profile);
    expect(report.foundMorphs).toContain('CustomSmile');
    expect(report.missingMorphs).not.toContain('CustomSmile');
    geometry.dispose();
  });
});
