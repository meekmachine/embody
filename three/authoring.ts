import type { AnimationClip, Mesh, Object3D } from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { requireInitializedEmbodyCore, CC4_HUMANOID_SKELETON_TEMPLATE, HUMANOID_SKELETON_TEMPLATES, DEFAULT_HAIR_COLOR_APPEARANCE } from '@lovelace_lol/embody/wasm';
import { ThreeModelInspector, serializeAnimationClips } from './index';
import type { Region } from './annotations/types';
import type * as Types from './authoringTypes';

export * from './authoringTypes';
export { resolveBoneNames, fuzzyNameMatch } from './annotations/adapter';
export {
  DEFAULT_AXIS_TO_CHANNEL, DEFAULT_BONE_MAX_DEGREES, JOINT_CONTROL_SECTION,
  VISEME_KEYS, HAIR_COLOR_PRESETS, DEFAULT_HAIR_COLOR_APPEARANCE, getAUDescriptors, LEGACY_BODY_CONTROL_AUS,
  HUMANOID_SKELETON_TEMPLATES, CC4_HUMANOID_SKELETON_TEMPLATE,
} from '@lovelace_lol/embody/wasm';

const json = (value: unknown) => JSON.stringify(value ?? {});
function request<T>(op: string, payload: unknown = {}): T {
  return JSON.parse(requireInitializedEmbodyCore().embody_request(json({ op, payload }))) as T;
}

export const getPreset = (id: Types.PresetType): Types.Profile => request('preset.get', { id });
export const extendCharacterConfigWithPreset = <T extends Types.ProfileRuntimeConfig>(config: T): T => request('profile.extendConfig', { config });
export const extractProfileOverrides = (config: Types.ProfileRuntimeConfig): Partial<Types.Profile> => request('profile.extractOverrides', { config });
export const mergeCharacterRegionsByName = (base?: Region[], override?: Region[]): Region[] => request('profile.mergeRegions', { base, override });
export const getMeshNamesForAUProfile = (profile: Types.Profile, auId: number): string[] => request('profile.getMeshNamesForAU', { profile, auId });
/** Resolve routing and legacy mesh aliases once for an editor inventory. */
export const resolveMorphMeshSelections = (
  profile: Partial<Pick<Types.Profile, 'morphToMesh' | 'visemeMeshCategory'>>,
  categories: string[], availableNames: string[],
): Record<string, Types.MorphMeshSelection> => request('profile.resolveMorphMeshSelections', { profile, categories, availableNames });
export const getHumanoidSpecification = (): Types.HumanoidSpecification => request('humanoid.getSpecification');
export const setAUMorphTargets = (profile: Types.Profile, auId: number, side: 'left' | 'right' | 'center', targets: Types.MorphTargetRef[]): Types.Profile => request('profile.setAUMorphTargets', { profile, auId, side, targets });
export const setHumanoidRoleBinding = (profile: Types.Profile, role: Types.VRMHumanoidRole, boneName: string | null): Types.Profile => request('profile.setHumanoidRoleBinding', { profile, role, boneName });
export const resolveHumanoidCharacterization = (profile: Types.Profile): Types.HumanoidCharacterizationResolution => request('profile.resolveHumanoidCharacterization', { profile });

export const hasLeftRightMorphs = (profile: Types.Profile, auId: number): boolean => request('profile.hasLeftRightMorphs', { profile, auId });
export const isMixedAU = (profile: Types.Profile, auId: number): boolean => request('profile.isMixedAU', { profile, auId });
export const resolveVisemeProfile = (profile: Partial<Types.Profile>): Types.ResolvedVisemeProfile => request('profile.resolveVisemes', { profile });

export const isMaxDegreesOnlyAxisBindingUpdate = (update: Types.BoneAxisBindingUpdate): boolean => request('bone.isMaxDegreesOnlyUpdate', { update });
export const findNodeKeyForBone = (boneName: string, profile: Types.Profile | null): string | null => profile ? request('bone.findNodeKey', { profile, boneName }) : null;
export const ensureBoneNodeKey = (profile: Types.Profile, boneName: string): { nodeKey: string; boneNodes: Record<string, string> } => request('bone.ensureNodeKey', { profile, boneName });
export const ensureBilateralBoneNodeKeys = (profile: Types.Profile, leftBoneName: string, rightBoneName: string): Types.Profile => request('bone.ensureBilateralNodeKeys', { profile, leftBoneName, rightBoneName });
export const resolveBoneNameForNodeKey = (profile: Types.Profile, nodeKey: string): string | null => request('bone.resolveBoneName', { profile, nodeKey });
export const stripConfiguredBoneAffixes = (profile: Pick<Types.Profile, 'bonePrefix' | 'boneSuffix'> | null | undefined, boneName: string): string => request('bone.stripAffixes', { profile: profile ?? {}, boneName });
export const inferChiralBoneNamePair = (boneNames: string[], selectedBoneName: string): Types.ChiralBoneNamePair | null => request('bone.inferChiralPair', { boneNames, selectedBoneName });
export const formatAxisLabel = (axis: Types.BoneAxisKey): string => request('bone.formatAxisLabel', { axis });
export const formatAxisDirectionLabel = (axis: Types.BoneAxisKey, direction: Types.BoneAxisDirection): string => request('bone.formatDirectionLabel', { axis, direction });
export const getAxisFromChannel = (channel?: string): Types.BoneAxisKey | null => channel ? request('bone.getAxisFromChannel', { channel }) : null;
export const getBoneAxisBindingState = (profile: Types.Profile, boneName: string, axis: Types.BoneAxisKey): Types.BoneAxisBindingState | null => request('bone.getAxisState', { profile, boneName, axis });
export const resolveBoneAxisChannel = (profile: Types.Profile, boneName: string, axis: Types.BoneAxisKey): Types.RotationChannel => request('bone.resolveAxisChannel', { profile, boneName, axis });
export const getBilateralAxisBindingState = (profile: Types.Profile, boneName: string, axis: Types.BoneAxisKey): Types.BilateralAxisBindingState | null => request('bone.getBilateralAxisState', { profile, boneName, axis });
export const getAUBoneBindingState = (profile: Types.Profile, auId: number): Types.AUBoneBindingState => request('bone.getAUBindingState', { profile, auId });
/** Resolve a panel's bone links without repeatedly serializing its full character. */
export const getAUBoneBindingStates = (
  profile: Partial<Pick<Types.Profile, 'auToBones' | 'boneNodes' | 'bonePrefix' | 'boneSuffix' | 'suffixPattern' | 'compositeRotations' | 'continuumPairs' | 'humanoidCharacterization'>>,
  auIds: readonly number[],
): Record<number, Types.AUBoneBindingState> => request('bone.getAUBindingStates', {
  profile: {
    auToBones: profile.auToBones, boneNodes: profile.boneNodes,
    bonePrefix: profile.bonePrefix, boneSuffix: profile.boneSuffix, suffixPattern: profile.suffixPattern,
    compositeRotations: profile.compositeRotations, continuumPairs: profile.continuumPairs,
    humanoidCharacterization: profile.humanoidCharacterization,
  },
  auIds,
});
export const inferEyeControlScope = (profile: Pick<Types.Profile, 'auToBones'>, binding: Pick<Types.BoneAxisBindingState, 'nodeKey' | 'negativeAuId' | 'positiveAuId'>): Types.BoneControlScope | null => request('bone.inferEyeScope', { profile, binding });
export const inferEyeControlFamily = (binding: Pick<Types.BoneAxisBindingState, 'nodeKey' | 'axis'>): Types.BoneControlFamily | null => request('bone.inferEyeFamily', { binding });
export const applyBoneAxisBindingUpdate = (profile: Types.Profile, boneName: string, axis: Types.BoneAxisKey, update: Types.BoneAxisBindingUpdate): Types.Profile => request('bone.applyAxisUpdate', { profile, boneName, axis, update });
export const applyBilateralAxisBindingUpdate = (profile: Types.Profile, boneName: string, axis: Types.BoneAxisKey, scope: Types.BilateralBoneAxisScope, update: Types.BoneAxisBindingUpdate): Types.Profile => request('bone.applyBilateralAxisUpdate', { profile, boneName, axis, scope, update });
export const applyAUBoneBindingUpdate = (profile: Types.Profile, auId: number, update: { boneName: string | null; axis: Types.BoneAxisKey; direction: Types.BoneAxisDirection; maxDegrees: number | null }): Types.Profile => request('bone.applyAUBindingUpdate', { profile, auId, update });
export const createBoneAxisAu = (profile: Types.Profile, boneName: string, axis: Types.BoneAxisKey, direction: Types.BoneAxisDirection, options: { name?: string } = {}): Types.CreatedBoneAxisAu => request('bone.createAxisAU', { profile, boneName, axis, direction, name: options.name });
export const createBilateralBoneAxisAu = (profile: Types.Profile, boneName: string, axis: Types.BoneAxisKey, scope: Types.BilateralBoneAxisScope, direction: Types.BoneAxisDirection, options: { name?: string } = {}): Types.CreatedBoneAxisAu => request('bone.createBilateralAxisAU', { profile, boneName, axis, scope, direction, name: options.name });
export const buildBoneAuOptions = (profile: Types.Profile): Array<{ value: string; label: string; detail?: string }> => request('bone.buildAUOptions', { profile });
export const isJointControlAuInfo = (info?: Pick<Types.AUInfo, 'facePart'> | null): boolean => request('bone.isJointControlInfo', { info });
export const classifyAuAsJointControl = (profile: Types.Profile, auId: number, options: { boneName?: string | null; nodeKey?: string | null } = {}): Types.Profile => request('bone.classifyJointControl', { profile, auId, boneName: options.boneName, nodeKey: options.nodeKey });
export const resolveContinuumDisplayLabel = (profile: Pick<Types.Profile, 'continuumPairs' | 'continuumLabels' | 'auInfo' | 'boneNodes' | 'bonePrefix' | 'boneSuffix'>, negativeAuId: number, positiveAuId: number): string => request<string | null>('bone.resolveContinuumLabel', { profile, negativeAuId, positiveAuId }) ?? `AU ${negativeAuId} <-> AU ${positiveAuId}`;

function inspectModel(model: Object3D, meshes?: Mesh[], profile?: Types.Profile) {
  return new ThreeModelInspector().inspectModel(model, { meshes, profile });
}

export function extractModelData(model: Object3D, meshes?: Mesh[], animations: AnimationClip[] = []): Types.ModelData {
  const inspection = inspectModel(model, meshes);
  return JSON.parse(requireInitializedEmbodyCore().extract_model_data_json(json(inspection.descriptor), json(serializeAnimationClips(model, animations, inspection))));
}
export async function analyzeModel(options: {
  source: { type: 'gltf'; gltf: GLTF } | { type: 'runtime'; model: Object3D; meshes?: Mesh[]; animations?: AnimationClip[] };
  preset?: Types.Profile; suggestCorrections?: boolean;
}): Promise<Types.ModelAnalysisReport> {
  const source = options.source;
  const model = source.type === 'gltf' ? source.gltf.scene ?? source.gltf.scenes[0] : source.model;
  const animations = source.type === 'gltf' ? source.gltf.animations : source.animations ?? [];
  const inspection = inspectModel(model, source.type === 'runtime' ? source.meshes : undefined);
  return JSON.parse(requireInitializedEmbodyCore().analyze_model_descriptor(json(inspection.descriptor), json(serializeAnimationClips(model, animations, inspection)), options.preset ? json(options.preset) : '', json({ suggestCorrections: Boolean(options.suggestCorrections) })));
}
type ValidationMesh = { name?: string; morphTargetDictionary?: Record<string, number>; geometry?: { morphTargetDictionary?: Record<string, number> } };
export function validateMappings(meshes: unknown[], skeleton: unknown, profile: Partial<Types.Profile>, options: Record<string, unknown> = {}): Types.ValidationResult {
  let nextMorphId = 1;
  const morphTargets: Array<{ id: number; meshId: number; name: string; hostIndex: number }> = [];
  const descriptorMeshes = (meshes ?? []).map((value, index) => {
    const mesh = value as ValidationMesh;
    const id = index + 1;
    const morphTargetIds = Object.entries(mesh.morphTargetDictionary ?? mesh.geometry?.morphTargetDictionary ?? {}).map(([name, hostIndex]) => {
      const morphId = nextMorphId++;
      morphTargets.push({ id: morphId, meshId: id, name, hostIndex });
      return morphId;
    });
    return { id, name: mesh.name ?? '', morphTargetIds, visible: true };
  });
  const bones = ((skeleton as { bones?: Array<string | { name?: string }> } | null)?.bones ?? []).map((bone, index) => ({ id: index + 1, name: typeof bone === 'string' ? bone : bone.name ?? '' }));
  return JSON.parse(requireInitializedEmbodyCore().validate_profile_model(json(profile), json({ meshes: descriptorMeshes, morphTargets, bones, objects: [] }), json(options)));
}
export function validateHumanoidCharacterization(model: Object3D, profile: Types.Profile): Types.HumanoidCharacterizationResolution {
  return JSON.parse(requireInitializedEmbodyCore().validate_humanoid_characterization(json(profile), json(inspectModel(model, undefined, profile).descriptor)));
}
export function normalizeHairColorAppearance(value: Types.HairColorAppearance | string, fallback: Types.HairColorAppearance = DEFAULT_HAIR_COLOR_APPEARANCE): Types.HairColorAppearance {
  return JSON.parse(requireInitializedEmbodyCore().normalize_hair_color_appearance_json(json(value), json(fallback)));
}
export const getHumanoidSkeletonTemplate = (id: string): Types.HumanoidSkeletonTemplate | null => (HUMANOID_SKELETON_TEMPLATES.find(template => template.id === id) ?? null) as unknown as Types.HumanoidSkeletonTemplate | null;
export function getHumanoidSkeletonTemplateBoneNames(template: Types.HumanoidSkeletonTemplate = CC4_HUMANOID_SKELETON_TEMPLATE as unknown as Types.HumanoidSkeletonTemplate): string[] {
  return JSON.parse(requireInitializedEmbodyCore().humanoid_skeleton_template_bone_names(json(template)));
}
export function createValidationSkeletonFromHumanoidTemplate(template: Types.HumanoidSkeletonTemplate = CC4_HUMANOID_SKELETON_TEMPLATE as unknown as Types.HumanoidSkeletonTemplate): { bones: Array<{ name: string }> } {
  return JSON.parse(requireInitializedEmbodyCore().create_validation_skeleton_json(json(template)));
}
export function computeHumanoidSkeletonTemplateRestBounds(template: Types.HumanoidSkeletonTemplate): Types.HumanoidSkeletonTemplateBounds {
  return Array.from(requireInitializedEmbodyCore().compute_humanoid_skeleton_template_rest_bounds(json(template))) as unknown as Types.HumanoidSkeletonTemplateBounds;
}
export function extractHumanoidSkeletonTemplateFromModel(model: Object3D, options: { id: string; sourceCharacterId: string; sourceAsset?: string; sourceSkinName?: string }): Types.HumanoidSkeletonTemplate {
  return JSON.parse(requireInitializedEmbodyCore().extract_humanoid_skeleton_template_json(json(inspectModel(model).descriptor), json(options)));
}

export type { AUDescriptor } from '@lovelace_lol/embody/wasm';
