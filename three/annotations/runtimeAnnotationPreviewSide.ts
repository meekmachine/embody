import type { RuntimeAnnotationSide } from './types';
import { annotationProfileInput, annotationQuery } from './runtime';
export function inferRuntimeAnnotationPreviewSide(auId: number, profile: { auToMorphs?: unknown; auToBones?: unknown } | null | undefined): RuntimeAnnotationSide | undefined { return annotationQuery<RuntimeAnnotationSide | null>('inferPreviewSide', { au: auId, profile: annotationProfileInput(profile) }) ?? undefined; }
export function pickContinuumAnnotationAuId(value: number, negId: number, posId: number, stickyId: number | null): number { return annotationQuery('continuumTarget', { value, negId, posId, stickyId }); }
