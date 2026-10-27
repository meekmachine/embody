import * as THREE from 'three';

const THREE_RENDERED_MORPH_SEMANTICS = ['position', 'normal', 'color'] as const;
type ThreeRenderedMorphSemantic = typeof THREE_RENDERED_MORPH_SEMANTICS[number];
type ThreeMorphAttribute = THREE.BufferAttribute | THREE.InterleavedBufferAttribute;

export interface CharacterMorphLayoutRepair {
  meshName: string;
  paddedChannels: Partial<Record<ThreeRenderedMorphSemantic, number>>;
  removedEmptyChannels: ThreeRenderedMorphSemantic[];
  paddedInfluences: number;
}

function resolveMorphTargetCount(mesh: THREE.Mesh): number {
  const morphAttributes = mesh.geometry.morphAttributes;
  const attributeCount = THREE_RENDERED_MORPH_SEMANTICS.reduce(
    (count, semantic) => Math.max(count, morphAttributes[semantic]?.length ?? 0),
    0,
  );
  const influenceCount = mesh.morphTargetInfluences?.length ?? 0;
  const dictionaryCount = Object.values(mesh.morphTargetDictionary ?? {}).reduce((count, index) => {
    if (!Number.isInteger(index) || index < 0) {
      throw new Error(
        `Mesh "${mesh.name || mesh.uuid}" has an invalid morph target dictionary index: ${index}.`,
      );
    }
    return Math.max(count, index + 1);
  }, 0);

  return Math.max(attributeCount, influenceCount, dictionaryCount);
}

function createNeutralMorphAttribute(
  mesh: THREE.Mesh,
  semantic: ThreeRenderedMorphSemantic,
  existingAttributes: ThreeMorphAttribute[],
  targetIndex: number,
): THREE.BufferAttribute {
  const geometry = mesh.geometry;
  const baseAttribute = geometry.getAttribute(semantic);
  const template = baseAttribute ?? existingAttributes.find(Boolean);
  if (!template) {
    throw new Error(
      `Mesh "${mesh.name || mesh.uuid}" cannot repair morph ${semantic}[${targetIndex}] `
      + 'because it has no base or existing attribute to copy.',
    );
  }

  const neutral = template.clone();
  if (geometry.morphTargetsRelative || !baseAttribute) {
    for (let vertexIndex = 0; vertexIndex < neutral.count; vertexIndex += 1) {
      for (let component = 0; component < neutral.itemSize; component += 1) {
        neutral.setComponent(vertexIndex, component, 0);
      }
    }
  }

  const targetName = Object.entries(mesh.morphTargetDictionary ?? {})
    .find(([, index]) => index === targetIndex)?.[0];
  neutral.name = targetName ?? '';
  return neutral;
}

/** Repair recoverable channel holes before Three.js builds its morph texture. */
export function normalizeRenderableCharacterMorphAttributes(
  model: THREE.Object3D,
): CharacterMorphLayoutRepair[] {
  const repairs: CharacterMorphLayoutRepair[] = [];

  model.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;

    const morphAttributes = mesh.geometry.morphAttributes;
    const removedEmptyChannels: ThreeRenderedMorphSemantic[] = [];
    for (const semantic of THREE_RENDERED_MORPH_SEMANTICS) {
      if (semantic !== 'position' && morphAttributes[semantic]?.length === 0) {
        delete morphAttributes[semantic];
        removedEmptyChannels.push(semantic);
      }
    }

    const targetCount = resolveMorphTargetCount(mesh);
    if (targetCount === 0) {
      if (morphAttributes.position?.length === 0) {
        delete morphAttributes.position;
        removedEmptyChannels.push('position');
      }
      if (removedEmptyChannels.length > 0) {
        repairs.push({
          meshName: mesh.name || mesh.uuid,
          paddedChannels: {},
          removedEmptyChannels,
          paddedInfluences: 0,
        });
      }
      return;
    }

    const positionCount = mesh.geometry.getAttribute('position')?.count;
    if (!positionCount) {
      throw new Error(
        `Mesh "${mesh.name || mesh.uuid}" has morph targets but no base position attribute.`,
      );
    }

    const paddedChannels: Partial<Record<ThreeRenderedMorphSemantic, number>> = {};
    for (const semantic of THREE_RENDERED_MORPH_SEMANTICS) {
      let attributes = morphAttributes[semantic];
      if (!attributes) {
        if (semantic !== 'position') continue;
        attributes = [];
        morphAttributes.position = attributes;
      }

      const baseAttribute = mesh.geometry.getAttribute(semantic);
      const referenceAttribute = baseAttribute ?? attributes.find(Boolean);
      const expectedItemSize = referenceAttribute?.itemSize;
      for (let targetIndex = 0; targetIndex < targetCount; targetIndex += 1) {
        const attribute = attributes[targetIndex];
        if (!attribute) {
          attributes[targetIndex] = createNeutralMorphAttribute(
            mesh,
            semantic,
            attributes,
            targetIndex,
          );
          paddedChannels[semantic] = (paddedChannels[semantic] ?? 0) + 1;
          continue;
        }

        if (attribute.count !== positionCount || attribute.itemSize !== expectedItemSize) {
          throw new Error(
            `Mesh "${mesh.name || mesh.uuid}" has an invalid morph ${semantic}[${targetIndex}] `
            + `(count=${attribute.count}, itemSize=${attribute.itemSize}; `
            + `expected count=${positionCount}, itemSize=${expectedItemSize}).`,
          );
        }
      }
    }

    const influences = mesh.morphTargetInfluences ?? [];
    const paddedInfluences = targetCount - influences.length;
    while (influences.length < targetCount) {
      influences.push(0);
    }
    mesh.morphTargetInfluences = influences;

    if (
      removedEmptyChannels.length > 0
      || Object.keys(paddedChannels).length > 0
      || paddedInfluences > 0
    ) {
      repairs.push({
        meshName: mesh.name || mesh.uuid,
        paddedChannels,
        removedEmptyChannels,
        paddedInfluences,
      });
    }
  });

  return repairs;
}

export function assertRenderableCharacterMorphAttributes(model: THREE.Object3D): void {
  model.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;

    const morphAttributes = mesh.geometry?.morphAttributes;
    const primary = morphAttributes?.position
      ?? morphAttributes?.normal
      ?? morphAttributes?.color;
    const targetCount = primary?.length ?? 0;
    if (targetCount === 0) return;

    const positionCount = mesh.geometry.getAttribute('position')?.count;
    const invalidSemantics = THREE_RENDERED_MORPH_SEMANTICS.filter((semantic) => {
      const attributes = morphAttributes[semantic];
      if (semantic === 'position' && !attributes) return true;
      if (!attributes) return false;
      const expectedItemSize = mesh.geometry.getAttribute(semantic)?.itemSize
        ?? attributes.find(Boolean)?.itemSize;
      return attributes.length !== targetCount
        || Array.from({ length: targetCount }, (_, index) => attributes[index])
          .some((attribute) => (
            !attribute
            || attribute.count !== positionCount
            || attribute.itemSize !== expectedItemSize
          ));
    });
    const influenceCount = mesh.morphTargetInfluences?.length ?? 0;

    if (invalidSemantics.length > 0 || influenceCount !== targetCount) {
      const channelCounts = THREE_RENDERED_MORPH_SEMANTICS
        .map((semantic) => `${semantic}=${morphAttributes[semantic]?.length ?? 0}`)
        .join(', ');
      throw new Error(
        `Mesh "${mesh.name || mesh.uuid}" has an invalid Three.js morph layout `
        + `(${channelCounts}, influences=${influenceCount}, expected=${targetCount}).`,
      );
    }
  });
}
