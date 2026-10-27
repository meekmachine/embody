import { requireInitializedEmbodyCore } from './index';

/** JavaScript names for the numeric Rust API used by profile tooling. */
export function isEmbodyCoreReady(): boolean {
  try { requireInitializedEmbodyCore(); return true; } catch { return false; }
}
export const coreAbiVersion = () => requireInitializedEmbodyCore().core_abi_version();
export const packMorphFrameDelta = (meshIds: Uint32Array, morphTargetIds: Uint32Array, values: Float32Array, modes: Uint8Array) => requireInitializedEmbodyCore().pack_morph_frame_delta(meshIds, morphTargetIds, values, modes);
export const solveBilateralValues = (base: number, balance: number) => requireInitializedEmbodyCore().solve_bilateral_values(base, balance);
export const solveMorphBatch = (values: Float32Array, balances: Float32Array, mixWeights: Float32Array) => requireInitializedEmbodyCore().solve_morph_batch(values, balances, mixWeights);
export const solveAxisQuaternion = (axis: number, degrees: number, value: number, scale: number) => requireInitializedEmbodyCore().solve_axis_quaternion(axis, degrees, value, scale);
export const analyzeMeshProportions = (vertices: Float32Array, verticalAxis: number) => requireInitializedEmbodyCore().analyze_mesh_proportions(vertices, verticalAxis);
export const solveTemplateSkeletonFit = (meshVertices: Float32Array, templateBounds: Float32Array, verticalAxis: number, verticalAnchor: number) => requireInitializedEmbodyCore().solve_template_skeleton_fit(meshVertices, templateBounds, verticalAxis, verticalAnchor);
export const composeTemplateFitAdjustment = (fit: Float32Array, scaleMultiplier: number, offsetX: number, offsetY: number, offsetZ: number) => requireInitializedEmbodyCore().compose_template_fit_adjustment(fit, scaleMultiplier, offsetX, offsetY, offsetZ);
export const composeTemplateSkeletonFitTransform = (fitScale: number, fitTranslation: Float32Array, manualScale: number, manualTranslation: Float32Array) => requireInitializedEmbodyCore().compose_template_skeleton_fit_transform(fitScale, fitTranslation, manualScale, manualTranslation);
export const defaultHairPhysicsConfigValues = () => requireInitializedEmbodyCore().default_hair_physics_config_values();
export function createHairPhysicsSolver(configValues = defaultHairPhysicsConfigValues()) {
  return new (requireInitializedEmbodyCore().HairPhysicsSolver)(configValues);
}
export function createRuntimeCore(visemeSlotCount: number) {
  return new (requireInitializedEmbodyCore().RuntimeCore)(visemeSlotCount);
}
