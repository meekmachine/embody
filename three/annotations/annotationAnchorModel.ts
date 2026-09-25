import type {
  AnnotationAnchoredRegion,
  AnnotationMarkerAnchor,
  Region,
} from './types';

export type MarkerAnchorProjectionMode = 'legacy' | 'project' | 'skip';

export interface ResolvedMarkerAnchorRegion {
  region: AnnotationAnchoredRegion;
  anchor: AnnotationMarkerAnchor | null;
  source: 'legacy-region' | 'marker-anchor';
  projection: MarkerAnchorProjectionMode;
  useLegacyRegionSemantics: boolean;
}

function cloneRegion(region: Region): AnnotationAnchoredRegion {
  return {
    ...(region as AnnotationAnchoredRegion),
  };
}

function copyTargets(
  target: AnnotationAnchoredRegion,
  anchor: AnnotationMarkerAnchor,
): AnnotationAnchoredRegion {
  const next = cloneRegion(target);

  if (anchor.bones) {
    next.bones = [...anchor.bones];
  }
  if (anchor.meshes) {
    next.meshes = [...anchor.meshes];
  }
  if (anchor.objects) {
    next.objects = [...anchor.objects];
  }

  return next;
}

function getExplicitMarkerAnchor(region: Region): AnnotationMarkerAnchor | null {
  return (region as AnnotationAnchoredRegion).markerAnchor ?? null;
}

function resolveExplicitProjection(anchor: AnnotationMarkerAnchor): MarkerAnchorProjectionMode {
  if (anchor.projectToSurface !== undefined) {
    return anchor.projectToSurface ? 'project' : 'skip';
  }

  if (anchor.type === 'point' || anchor.type === 'mesh') {
    return 'skip';
  }

  return 'project';
}

/**
 * Convert explicit marker-anchor intent into the legacy region target fields
 * that the current marker renderers understand.
 */
export function resolveMarkerAnchorRegion(region: Region): ResolvedMarkerAnchorRegion {
  const anchor = getExplicitMarkerAnchor(region);
  if (!anchor) {
    return {
      region: region as AnnotationAnchoredRegion,
      anchor: null,
      source: 'legacy-region',
      projection: 'legacy',
      useLegacyRegionSemantics: true,
    };
  }

  if (anchor.type === 'region') {
    return {
      region: region as AnnotationAnchoredRegion,
      anchor,
      source: 'marker-anchor',
      projection: anchor.projectToSurface === undefined
        ? 'legacy'
        : anchor.projectToSurface
          ? 'project'
          : 'skip',
      useLegacyRegionSemantics: true,
    };
  }

  if (anchor.type === 'point' && anchor.position) {
    return {
      region: {
        ...cloneRegion(region),
        bones: undefined,
        meshes: undefined,
        objects: undefined,
        customPosition: { ...anchor.position },
      },
      anchor,
      source: 'marker-anchor',
      projection: resolveExplicitProjection(anchor),
      useLegacyRegionSemantics: false,
    };
  }

  const next = copyTargets(
    {
      ...cloneRegion(region),
      bones: undefined,
      meshes: undefined,
      objects: undefined,
      customPosition: undefined,
    },
    anchor,
  );

  if (anchor.type === 'bone' && !next.bones) {
    next.bones = (region as AnnotationAnchoredRegion).bones;
  } else if (anchor.type === 'mesh' && !next.meshes) {
    next.meshes = (region as AnnotationAnchoredRegion).meshes;
  } else if (anchor.type === 'object' && !next.objects) {
    next.objects = (region as AnnotationAnchoredRegion).objects;
  } else if (anchor.type === 'face-center') {
    next.bones = next.bones ?? (region as AnnotationAnchoredRegion).bones;
    next.meshes = next.meshes ?? (region as AnnotationAnchoredRegion).meshes;
  }

  return {
    region: next,
    anchor,
    source: 'marker-anchor',
    projection: resolveExplicitProjection(anchor),
    useLegacyRegionSemantics: false,
  };
}

export function shouldUseFaceCenterForMarkerAnchor(
  resolved: ResolvedMarkerAnchorRegion,
): boolean {
  if (resolved.anchor?.type === 'face-center') {
    return true;
  }

  return resolved.useLegacyRegionSemantics && resolved.region.name.toLowerCase().includes('face');
}

export function shouldProjectMarkerAnchorToSurface(
  resolved: ResolvedMarkerAnchorRegion,
  legacyDefault: boolean,
): boolean {
  if (resolved.projection === 'legacy') {
    return legacyDefault;
  }

  return resolved.projection === 'project';
}
