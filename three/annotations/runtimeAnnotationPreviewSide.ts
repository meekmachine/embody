import type { RuntimeAnnotationSide } from './types';

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => typeof entry === 'string' && entry.trim() ? [entry.trim()] : []);
}

function inferSideFromText(value: string): RuntimeAnnotationSide | undefined {
  const normalized = value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase();
  const tokens = normalized.split(/[^a-z0-9]+/).filter(Boolean);
  const hasLeft = tokens.includes('left') || tokens.includes('l');
  const hasRight = tokens.includes('right') || tokens.includes('r');

  if (hasLeft === hasRight) return undefined;
  return hasLeft ? 'left' : 'right';
}

function addSide(sides: Set<RuntimeAnnotationSide>, side: unknown): void {
  if (side === 'left' || side === 'right' || side === 'center') {
    sides.add(side);
  }
}

export function inferRuntimeAnnotationPreviewSide(
  auId: number,
  profile: { auToMorphs?: unknown; auToBones?: unknown } | null | undefined,
): RuntimeAnnotationSide | undefined {
  if (!profile) return undefined;

  const auKey = String(auId);
  const sides = new Set<RuntimeAnnotationSide>();
  const profileRecord = profile as unknown as Record<string, unknown>;
  const auToMorphs = isPlainRecord(profileRecord.auToMorphs) ? profileRecord.auToMorphs : {};
  const auToBones = isPlainRecord(profileRecord.auToBones) ? profileRecord.auToBones : {};
  const morphMapping = auToMorphs[auKey];

  if (isPlainRecord(morphMapping)) {
    if (readStringArray(morphMapping.left).length > 0) sides.add('left');
    if (readStringArray(morphMapping.right).length > 0) sides.add('right');
    if (readStringArray(morphMapping.center).length > 0) sides.add('center');
  } else {
    for (const morphName of readStringArray(morphMapping)) {
      addSide(sides, inferSideFromText(morphName));
    }
  }

  const boneBindings = auToBones[auKey];
  if (Array.isArray(boneBindings)) {
    for (const binding of boneBindings) {
      if (typeof binding === 'string') {
        addSide(sides, inferSideFromText(binding));
      } else if (isPlainRecord(binding)) {
        addSide(sides, binding.side);
        const name = binding.node ?? binding.boneName ?? binding.bone ?? binding.name;
        if (typeof name === 'string') {
          addSide(sides, inferSideFromText(name));
        }
      }
    }
  }

  const lateralSides = [...sides].filter((side) => side === 'left' || side === 'right');
  if (lateralSides.length === 1) return lateralSides[0];
  if (lateralSides.length > 1) return undefined;
  return sides.has('center') ? 'center' : undefined;
}

/**
 * Pick which continuum AU to annotate. While a drag gesture is sticky, keep
 * the original side so crossing 0 does not rebuild runtime markers mid-drag.
 */
export function pickContinuumAnnotationAuId(
  value: number,
  negId: number,
  posId: number,
  stickyId: number | null,
): number {
  if (stickyId === negId || stickyId === posId) {
    return stickyId;
  }
  if (value < 0) return negId;
  if (value > 0) return posId;
  return negId;
}
