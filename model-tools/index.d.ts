export type ActorModelKind = 'original' | 'optimized' | 'low-resolution' | 'miniature' | 'bust' | 'outfit';

export interface ActorModelMesh {
  /** Source-file mesh index, scoped to this inspection. Never infer clothing from a name. */
  id: string;
  name: string;
  nodeNames: string[];
  materials: string[];
  primitiveCount: number;
  vertexCount: number;
  triangleCount: number;
  skinned: boolean;
  morphTargetCount: number;
}

export interface ActorModelInspection {
  byteLength: number;
  vertexCount: number;
  triangleCount: number;
  meshes: ActorModelMesh[];
  animationCount: number;
  skinCount: number;
  /** Only self-contained, extension-free GLB files may be transformed. */
  canTransform: boolean;
  unsupportedExtensions: string[];
  warnings: string[];
}

export interface PrepareActorModelOptions {
  kind: ActorModelKind;
  /** Explicit source mesh IDs to remove, including all instances of each mesh. */
  removeMeshIds?: string[];
  /** Required for bust: keep these whole meshes. Does not cut a combined body mesh. */
  keepMeshIds?: string[];
  /** Fraction of triangles to retain, 0.05–1. Defaults to 0.5 for low-resolution. */
  targetRatio?: number;
  /** Maximum geometric error relative to primitive extent, 0–0.05. Default 0.001. */
  maxError?: number;
  /** Required for miniature: uniform scale 0.01–0.99, applied above existing scene roots. */
  scale?: number;
  /** Checked between processing stages/primitives; a running synchronous primitive cannot be interrupted. */
  signal?: AbortSignal;
}

export interface PreparedActorModel {
  bytes: Uint8Array;
  before: ActorModelInspection;
  after: ActorModelInspection;
  removedMeshIds: string[];
  warnings: string[];
}

/** Inspect a GLB without changing its bytes or fetching external resources. */
export function inspectActorModel(source: Uint8Array, options?: { signal?: AbortSignal }): Promise<ActorModelInspection>;

/** Prepare a new GLB. The caller retains ownership of source and persists the returned bytes separately. */
export function prepareActorModel(source: Uint8Array, options: PrepareActorModelOptions): Promise<PreparedActorModel>;
