import { requireInitializedEmbodyCore } from '@lovelace_lol/embody/wasm';
import type { AnnotationAnchoredRegion, AnnotationCharacterConfig, CameraState, ExpandedRegionState, MarkerStyle, MarkerStyleOverrides, LineConfig } from './types';

export function annotationQuery<T>(operation: string, payload: unknown): T {
  return JSON.parse(requireInitializedEmbodyCore().annotation_query(operation, JSON.stringify(payload))) as T;
}
export type NativeAnnotationRuntime = InstanceType<ReturnType<typeof requireInitializedEmbodyCore>['AnnotationRuntime']>;
export interface MarkerDescriptor {
  id: number;
  name: string;
  label: string;
  title: string;
  htmlText: string;
  style: Required<Omit<MarkerStyleOverrides, 'line'>> & { line: Required<LineConfig> };
  radius: number;
  arrowLength: number;
  arrowRadius: number;
}
export interface AnnotationSnapshot {
  generation: number;
  revision: number;
  descriptorRevision: number;
  configRevision: number;
  disposed: boolean;
  loaded: boolean;
  visible: boolean;
  style: MarkerStyle;
  currentRegion: string | null;
  solo: string | null;
  regions: AnnotationAnchoredRegion[];
  config: AnnotationCharacterConfig;
  descriptors: MarkerDescriptor[];
  camera: CameraState;
  expanded: ExpandedRegionState[];
}
export interface SurfaceQuery { id: number; generation: number; phase: number; origin: [number, number, number]; direction: [number, number, number]; far: number; }

/** Only annotation contract data crosses Wasm; host resources/metadata stay borrowed. */
export function annotationConfigInput(config: AnnotationCharacterConfig): Record<string, unknown> {
  const keys = ['characterId', 'characterName', 'regions', 'annotationRegions', 'disabledRegions', 'markerStyle', 'playIntroOnLoad', 'defaultRegion', 'boneNodes', 'bonePrefix', 'boneSuffix', 'suffixPattern', 'auToMorphs', 'auToBones', 'morphToMesh', 'markerGroups', 'lineDefaults', 'markerDefaults'] as const;
  const result: Record<string, unknown> = {};
  for (const key of keys) if (config[key] !== undefined) result[key] = config[key];
  if (config.profile) result.profile = Object.fromEntries(keys.filter(key => config.profile?.[key] !== undefined).map(key => [key, config.profile![key]]));
  return result;
}

/** Profile transport selects contract fields without traversing host metadata. */
export function annotationProfileInput(profile: unknown): unknown {
  if (typeof profile !== 'object' || profile === null || Array.isArray(profile)) return undefined;
  const source = profile as Record<string, unknown>;
  const fields = ['auToBones', 'auToMorphs', 'morphToMesh', 'boneNodes', 'bonePrefix', 'boneSuffix', 'suffixPattern'];
  const result = Object.fromEntries(fields.filter(key => source[key] !== undefined).map(key => [key, source[key]]));
  const nested = source.profile;
  if (typeof nested === 'object' && nested !== null && !Array.isArray(nested)) {
    const value = nested as Record<string, unknown>;
    result.profile = Object.fromEntries(fields.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
  }
  return result;
}
