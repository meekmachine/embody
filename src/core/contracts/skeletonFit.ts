import type { Vec3 } from './primitives';

export const TEMPLATE_SKELETON_FIT_METADATA_KIND = 'template-skeleton-fit';
export const TEMPLATE_SKELETON_FIT_METADATA_VERSION = 1;

export const TEMPLATE_SKELETON_FIT_STATUSES = [
  'unfitted',
  'estimated',
  'manual-adjusted',
  'invalid',
] as const;

export const TEMPLATE_SKELETON_FIT_VERTICAL_AXES = ['x', 'y', 'z'] as const;
export const TEMPLATE_SKELETON_FIT_VERTICAL_ANCHORS = ['min', 'center', 'max'] as const;

export type TemplateSkeletonFitStatus = (typeof TEMPLATE_SKELETON_FIT_STATUSES)[number];
export type TemplateSkeletonFitVerticalAxis = (typeof TEMPLATE_SKELETON_FIT_VERTICAL_AXES)[number];
export type TemplateSkeletonFitVerticalAnchor = (typeof TEMPLATE_SKELETON_FIT_VERTICAL_ANCHORS)[number];

export interface TemplateSkeletonFitTransform {
  readonly scale: number;
  readonly translation: Vec3;
}

export interface TemplateSkeletonFitMetrics extends TemplateSkeletonFitTransform {
  readonly confidence: number;
  readonly meshHeight: number;
  readonly templateHeight: number;
  readonly crossAxisSpans: Vec3;
  readonly status: TemplateSkeletonFitStatus;
}

export interface TemplateSkeletonFitManualAdjustment {
  readonly scale?: number;
  readonly translation?: Vec3;
}

export interface TemplateSkeletonFitMetadata {
  readonly kind: typeof TEMPLATE_SKELETON_FIT_METADATA_KIND;
  readonly version: typeof TEMPLATE_SKELETON_FIT_METADATA_VERSION;
  readonly templateId: string;
  readonly sourceCharacterId: string;
  readonly verticalAxis: TemplateSkeletonFitVerticalAxis;
  readonly verticalAnchor: TemplateSkeletonFitVerticalAnchor;
  readonly fit: TemplateSkeletonFitMetrics;
  readonly manualAdjustment?: TemplateSkeletonFitManualAdjustment;
}

export interface TemplateSkeletonFitValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

export function isTemplateSkeletonFitStatus(value: unknown): value is TemplateSkeletonFitStatus {
  return typeof value === 'string' && TEMPLATE_SKELETON_FIT_STATUSES.includes(value as TemplateSkeletonFitStatus);
}

export function composeTemplateSkeletonFitTransform(
  fit: TemplateSkeletonFitTransform,
  manualAdjustment: TemplateSkeletonFitManualAdjustment = {},
): TemplateSkeletonFitTransform {
  return {
    scale: positiveFiniteOr(fit.scale, 1) * positiveFiniteOr(manualAdjustment.scale ?? 1, 1),
    translation: {
      x: finiteOr(fit.translation.x, 0) + finiteOr(manualAdjustment.translation?.x ?? 0, 0),
      y: finiteOr(fit.translation.y, 0) + finiteOr(manualAdjustment.translation?.y ?? 0, 0),
      z: finiteOr(fit.translation.z, 0) + finiteOr(manualAdjustment.translation?.z ?? 0, 0),
    },
  };
}

export function validateTemplateSkeletonFitMetadata(metadata: unknown): TemplateSkeletonFitValidationResult {
  const errors: string[] = [];

  if (!isRecord(metadata)) {
    return { valid: false, errors: ['metadata must be an object'] };
  }

  if (metadata.kind !== TEMPLATE_SKELETON_FIT_METADATA_KIND) {
    errors.push(`kind must be "${TEMPLATE_SKELETON_FIT_METADATA_KIND}"`);
  }
  if (metadata.version !== TEMPLATE_SKELETON_FIT_METADATA_VERSION) {
    errors.push(`version must be ${TEMPLATE_SKELETON_FIT_METADATA_VERSION}`);
  }
  if (!isNonEmptyString(metadata.templateId)) {
    errors.push('templateId must be a non-empty string');
  }
  if (!isNonEmptyString(metadata.sourceCharacterId)) {
    errors.push('sourceCharacterId must be a non-empty string');
  }
  if (!TEMPLATE_SKELETON_FIT_VERTICAL_AXES.includes(metadata.verticalAxis as TemplateSkeletonFitVerticalAxis)) {
    errors.push(`verticalAxis must be one of: ${TEMPLATE_SKELETON_FIT_VERTICAL_AXES.join(', ')}`);
  }
  if (!TEMPLATE_SKELETON_FIT_VERTICAL_ANCHORS.includes(metadata.verticalAnchor as TemplateSkeletonFitVerticalAnchor)) {
    errors.push(`verticalAnchor must be one of: ${TEMPLATE_SKELETON_FIT_VERTICAL_ANCHORS.join(', ')}`);
  }

  validateFitMetrics(metadata.fit, errors);
  validateManualAdjustment(metadata.manualAdjustment, errors);

  return { valid: errors.length === 0, errors };
}

function validateFitMetrics(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push('fit must be an object');
    return;
  }

  if (!isPositiveFiniteNumber(value.scale)) {
    errors.push('fit.scale must be a positive finite number');
  }
  validateVec3(value.translation, 'fit.translation', errors);
  if (!isFiniteNumber(value.confidence) || value.confidence < 0 || value.confidence > 1) {
    errors.push('fit.confidence must be a finite number between 0 and 1');
  }
  if (!isPositiveFiniteNumber(value.meshHeight)) {
    errors.push('fit.meshHeight must be a positive finite number');
  }
  if (!isPositiveFiniteNumber(value.templateHeight)) {
    errors.push('fit.templateHeight must be a positive finite number');
  }
  validateVec3(value.crossAxisSpans, 'fit.crossAxisSpans', errors, { min: 0 });
  if (!isTemplateSkeletonFitStatus(value.status)) {
    errors.push(`fit.status must be one of: ${TEMPLATE_SKELETON_FIT_STATUSES.join(', ')}`);
  }
}

function validateManualAdjustment(value: unknown, errors: string[]): void {
  if (value == null) {
    return;
  }
  if (!isRecord(value)) {
    errors.push('manualAdjustment must be an object');
    return;
  }
  if (value.scale != null && !isPositiveFiniteNumber(value.scale)) {
    errors.push('manualAdjustment.scale must be a positive finite number');
  }
  if (value.translation != null) {
    validateVec3(value.translation, 'manualAdjustment.translation', errors);
  }
}

function validateVec3(
  value: unknown,
  field: string,
  errors: string[],
  options: { min?: number } = {},
): void {
  if (!isRecord(value)) {
    errors.push(`${field} must be an object with finite x, y, and z values`);
    return;
  }

  for (const axis of ['x', 'y', 'z'] as const) {
    const axisValue = value[axis];
    if (!isFiniteNumber(axisValue)) {
      errors.push(`${field}.${axis} must be a finite number`);
    } else if (options.min != null && axisValue < options.min) {
      errors.push(`${field}.${axis} must be a finite number >= ${options.min}`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function positiveFiniteOr(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
