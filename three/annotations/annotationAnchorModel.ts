import type { AnnotationAnchoredRegion, AnnotationMarkerAnchor, Region } from './types';
import { annotationQuery } from './runtime';
export type MarkerAnchorProjectionMode = 'legacy' | 'project' | 'skip';
export interface ResolvedMarkerAnchorRegion { region: AnnotationAnchoredRegion; anchor: AnnotationMarkerAnchor | null; source: 'legacy-region' | 'marker-anchor'; projection: MarkerAnchorProjectionMode; useLegacyRegionSemantics: boolean; }
export function resolveMarkerAnchorRegion(region: Region): ResolvedMarkerAnchorRegion { return annotationQuery('anchor', { region }); }
export function shouldUseFaceCenterForMarkerAnchor(resolved: ResolvedMarkerAnchorRegion): boolean { return annotationQuery('faceAnchor', { resolved }); }
export function shouldProjectMarkerAnchorToSurface(resolved: ResolvedMarkerAnchorRegion, legacyDefault: boolean): boolean { return annotationQuery('projectAnchor', { resolved, legacyDefault }); }
