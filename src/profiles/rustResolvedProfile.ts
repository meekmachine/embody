import type { BoneBinding, CompositeRotation } from '../core/types';
import type { HairPhysicsProfileConfig, MappingEditorSection, MeshInfo, MorphTargetRef, Profile, VisemeSlot } from '../mappings/types';
import type { EmbodyCoreWasmModule } from '../wasmTypes';

export interface RustResolvedVisemeBindingTarget {
  morph: MorphTargetRef;
  weight: number;
}

export interface RustResolvedProfileView {
  visemeSlots: VisemeSlot[];
  visemeJawAmounts: number[];
  visemeBindingTargets: RustResolvedVisemeBindingTarget[][];
  visemeMeshCategory: string;
  visemeMeshNames: string[];
  auMeshNames: Record<string, string[]>;
  meshes: Record<string, MeshInfo>;
  mappingSections: MappingEditorSection[];
  auFacePartToMeshCategory: Record<string, string>;
  auMixDefaults: Record<string, number>;
  boneNodes: Record<string, string>;
  auToBones: Record<string, BoneBinding[]>;
  compositeRotations: CompositeRotation[];
  continuumPairs: Record<string, {
    pairId: number;
    isNegative: boolean;
    axis?: 'pitch' | 'yaw' | 'roll';
    node?: string;
  } | null>;
  hairPhysics?: HairPhysicsProfileConfig;
}

export function resolveRustProfileView(
  wasm: EmbodyCoreWasmModule,
  profile: Profile | Record<string, unknown>
): RustResolvedProfileView {
  return JSON.parse(wasm.resolve_profile_view(JSON.stringify(profile))) as RustResolvedProfileView;
}

export function resolveRustEmbeddedProfileView(
  wasm: EmbodyCoreWasmModule,
  presetId: string,
  profileOverride: Partial<Profile> | Record<string, unknown> | null = null
): RustResolvedProfileView {
  return JSON.parse(
    wasm.resolve_embedded_profile_view(presetId, profileOverride ? JSON.stringify(profileOverride) : '')
  ) as RustResolvedProfileView;
}
