import { Box3, Quaternion, Vector3, type Object3D } from 'three';
import { initEmbodyCore, requireInitializedEmbodyCore, type EmbodyCore, type CameraFlight, type CameraOrbit } from '@lovelace_lol/embody/wasm';
import type { AnnotationCharacterConfig, AnnotationLaterality, BoneResolutionProfile, Region } from './types';
export { initEmbodyCore } from '@lovelace_lol/embody/wasm';
export type { AnnotationLaterality, BoneResolutionProfile } from './types';

type Point = { x: number; y: number; z: number };
type Rotation = Point & { w: number };
type Bounds = { center: Point; size: Point };
const vec = (v: Point) => new Float32Array([v.x, v.y, v.z]);
const quat = (q?: Rotation | null) => new Float32Array(q ? [q.x, q.y, q.z, q.w] : []);
const bounds = (b?: Bounds | null) => new Float32Array(b ? [b.center.x, b.center.y, b.center.z, b.size.x, b.size.y, b.size.z] : []);
const point = (values: ArrayLike<number>, offset = 0): Point => ({ x: values[offset], y: values[offset + 1], z: values[offset + 2] });
const framing = (v: ArrayLike<number>) => ({ position: point(v), target: point(v, 3), distance: v[6] });

/** Typed, allocation-only bridge to the canonical Rust camera and marker algorithms. */
export class RustAnnotationCameraCore {
  constructor(private readonly core: EmbodyCore) {}
  static async create() { return new RustAnnotationCameraCore(await initEmbodyCore()); }
  normalizeCameraAngle(angle: number) { return this.core.normalize_camera_angle_degrees(angle); }
  worldDirectionForCameraAngle(q: Rotation | undefined, angle: number) { return point(this.core.world_direction_for_camera_angle(quat(q), angle)); }
  resolveFocusCameraDirection(q: Rotation | undefined, effectiveAngle: number, cameraAngle?: number, angleSpace = 'model') {
    return point(this.core.resolve_focus_camera_direction(quat(q), effectiveAngle, cameraAngle != null, angleSpace === 'world'));
  }
  resolveAutoCloseupAngle(offset: number, focusSize: Point, modelSize: Point) { return this.core.resolve_auto_closeup_angle(offset, vec(focusSize), vec(modelSize)); }
  focusPaddingFactor(size: number, closeUp: number, zoom: number, fullBody: number) { return this.core.focus_padding_factor(size, closeUp, zoom, fullBody); }
  solveFocusFraming(o: { focusBounds?: Bounds; modelBounds?: Bounds | null; modelQuaternion?: Rotation; fovDegrees: number; aspect: number; minDistance: number; closeUpPaddingFactor: number; zoomPaddingFactor: number; fullBodyPaddingFactor: number; overridePadding?: number; cameraAngle?: number; angleSpace?: string }) {
    return framing(this.core.solve_focus_framing(bounds(o.focusBounds), bounds(o.modelBounds), quat(o.modelQuaternion), o.fovDegrees, o.aspect, o.minDistance, o.closeUpPaddingFactor, o.zoomPaddingFactor, o.fullBodyPaddingFactor, o.overridePadding, o.cameraAngle, o.angleSpace === 'world'));
  }
  solveFullBodyFraming(o: { boxMin: Point; boxMax: Point; modelQuaternion?: Rotation; fovDegrees: number; aspect: number; minDistance: number; fullBodyPaddingFactor: number; overridePadding?: number; cameraAngle?: number; angleSpace?: string }) {
    return framing(this.core.solve_full_body_framing(vec(o.boxMin), vec(o.boxMax), quat(o.modelQuaternion), o.fovDegrees, o.aspect, o.minDistance, o.fullBodyPaddingFactor, o.overridePadding, o.cameraAngle, o.angleSpace === 'world'));
  }
  passesMarkerCameraAngleGate(o: { markerAngle?: number; currentCameraAngle?: number; rangeDegrees?: number }) { return this.core.passes_marker_camera_angle_gate(o.markerAngle, o.currentCameraAngle, o.rangeDegrees); }
  shouldShowMarker(o: { hiddenChild: boolean; solo: 'none' | 'soloed' | 'other-soloed'; markerAngle?: number; currentCameraAngle?: number }) {
    return this.core.should_show_marker(o.hiddenChild, o.solo === 'soloed' ? 1 : o.solo === 'other-soloed' ? 2 : 0, o.markerAngle, o.currentCameraAngle);
  }
  resolveViewportConstrainedLineScale(o: { startClip: ArrayLike<number>; endClip: ArrayLike<number>; safeX: number; safeY: number; minLengthRatio?: number }) {
    const v = this.core.resolve_viewport_constrained_line_scale(new Float32Array(o.startClip), new Float32Array(o.endClip), o.safeX, o.safeY, o.minLengthRatio);
    return { visible: v[0] >= 1, lineScale: v[1] };
  }
  resolveViewportSafeBounds(o: { labelScaleX: number; labelScaleY: number; projectionXScale: number; projectionYScale: number; viewportWidth: number; viewportHeight: number; edgePaddingPx?: number }) {
    const v = this.core.resolve_viewport_safe_bounds(o.labelScaleX, o.labelScaleY, o.projectionXScale, o.projectionYScale, o.viewportWidth, o.viewportHeight, o.edgePaddingPx);
    return { safeX: v[0], safeY: v[1] };
  }
  sampleMarkerBezierCurve(start: Point, end: Point, segments = 16) { return this.core.sample_marker_bezier_curve(vec(start), vec(end), segments); }
  sampleMarkerArcCurve(start: Point, end: Point, segments = 16) { return this.core.sample_marker_arc_curve(vec(start), vec(end), segments); }
  markerVisibilityAnimationFactors(visible: boolean, t: number) {
    const v = this.core.marker_visibility_animation_factors(visible, t);
    return { itemOpacityFactor: v[0], labelScaleFactor: v[1], lineOpacityFactor: v[2] };
  }
  separateOverlappingMarkerEndpoints(o: { starts: ArrayLike<number>; ends: ArrayLike<number>; modelCenter: Point; modelHeight: number }) { return this.core.separate_overlapping_marker_endpoints(new Float32Array(o.starts), new Float32Array(o.ends), vec(o.modelCenter), o.modelHeight); }
  createCameraFlight(start: Point, startTarget: Point, end: Point, endTarget: Point, duration: number) { return animationHandle(new this.core.CameraFlight(vec(start), vec(startTarget), vec(end), vec(endTarget), duration)); }
  createCameraOrbit(center: Point, radius: number, height: number, duration: number) { return animationHandle(new this.core.CameraOrbit(vec(center), radius, height, duration)); }
}

function animationHandle(handle: CameraFlight | CameraOrbit) {
  let disposed = false;
  return {
    sample(elapsed: number) {
      const v = handle.sample(elapsed);
      return { position: point(v), target: point(v, 3), done: v[6] >= 1 };
    },
    get durationMs() { return handle.duration_ms(); },
    dispose() { if (!disposed) { disposed = true; handle.free(); } },
  };
}
export const createRustAnnotationCameraCore = () => RustAnnotationCameraCore.create();

function request<T>(op: string, payload: unknown): T {
  return JSON.parse(requireInitializedEmbodyCore().embody_request(JSON.stringify({ op, payload }))) as T;
}

/** Resolve only annotation/profile inputs, preserving host-only data by reference. */
export async function resolveAnnotationCharacterConfig<T extends AnnotationCharacterConfig>(config: T): Promise<T> {
  await initEmbodyCore();
  const keys = ['profilePresetId', 'presetId', 'baseProfileId', 'auPresetType', 'annotationRegions', 'regions', 'disabledRegions', 'boneNodes', 'bonePrefix', 'boneSuffix', 'suffixPattern', 'auToMorphs', 'auToBones', 'morphToMesh', 'markerGroups', 'lineDefaults', 'markerDefaults'] as const;
  const input: Record<string, unknown> = {};
  for (const key of keys) if (config[key] !== undefined) input[key] = config[key];
  if (config.profile) {
    input.profile = Object.fromEntries(keys.filter(k => config.profile?.[k] !== undefined).map(k => [k, config.profile![k]]));
  }
  const extended = request<Record<string, unknown>>('profile.extendConfig', { config: input });
  const resolved = { ...config };
  for (const key of keys) if (extended[key] !== undefined) (resolved as Record<string, unknown>)[key] = extended[key];
  resolved.regions ??= resolved.annotationRegions ?? [];
  return resolved;
}

export function resolveBoneNames(names: string[] | undefined, profile?: BoneResolutionProfile | null): string[] {
  if (!names?.length) return [];
  return profile ? request('profile.resolveBoneNames', { profile, names }) : [...new Set(names)];
}
export function fuzzyNameMatch(objectName: string, targetName: string, suffixPattern?: string): boolean { return request('name.fuzzyMatch', { objectName, targetName, suffixPattern }); }
export function getDefaultAnnotationLaterality(): AnnotationLaterality { return { leftSideX: -1, confidence: 0, evidence: ['default:left=-X'] }; }
function semanticSide(name: string) { return /(^|[_\s-])(left|right)(?=$|[_\s-])/i.exec(name)?.[2].toLowerCase() as 'left' | 'right' | undefined; }
export function getSemanticHorizontalSignForSide(side: 'left' | 'right', laterality: AnnotationLaterality): 1 | -1 { return side === 'left' ? laterality.leftSideX : laterality.leftSideX === 1 ? -1 : 1; }
export function getSemanticHorizontalSign(name: string, laterality: AnnotationLaterality) { const side = semanticSide(name); return side ? getSemanticHorizontalSignForSide(side, laterality) : null; }
export function resolveRegionCameraAngle(region: Region, laterality: AnnotationLaterality) {
  if (region.cameraAngle == null) return undefined;
  const angle = requireInitializedEmbodyCore().normalize_camera_angle_degrees(region.cameraAngle);
  const side = semanticSide(region.name);
  return side && (angle === 90 || angle === 270) ? getSemanticHorizontalSignForSide(side, laterality) > 0 ? 90 : 270 : angle;
}
export function resolveRegionVisibilityCameraAngle(region: Region, laterality: AnnotationLaterality) {
  const angle = resolveRegionCameraAngle(region, laterality);
  const side = semanticSide(region.name);
  return angle ?? (region.parent && side ? getSemanticHorizontalSignForSide(side, laterality) > 0 ? 90 : 270 : undefined);
}
function modelQuaternion(model: Object3D | null) { if (!model) return undefined; model.updateMatrixWorld(true); return model.getWorldQuaternion(new Quaternion()); }
export function toWorldDirection(model: Object3D | null, local: Vector3) { const q = modelQuaternion(model); const direction = local.clone(); return (q ? direction.applyQuaternion(q) : direction).normalize(); }
export function getWorldDirectionForCameraAngle(model: Object3D | null, angle: number) { const v = requireInitializedEmbodyCore().world_direction_for_camera_angle(quat(modelQuaternion(model)), angle); return new Vector3(v[0], v[1], v[2]); }
export function getModelLocalOrbitAngle(model: Object3D | null, center: Vector3, position: Vector3) {
  const local = position.clone().sub(center); const q = modelQuaternion(model); if (q) local.applyQuaternion(q.invert()); local.normalize();
  return requireInitializedEmbodyCore().normalize_camera_angle_degrees(Math.atan2(local.x, local.z) * 180 / Math.PI);
}
export function passesMarkerCameraAngleGate(o: { markerAngle?: number; currentCameraAngle?: number; rangeDegrees?: number }) { return requireInitializedEmbodyCore().passes_marker_camera_angle_gate(o.markerAngle, o.currentCameraAngle, o.rangeDegrees); }

const matches = (name: string, target: string, suffix?: string) => fuzzyNameMatch(name, target, suffix) || name.toLowerCase().includes(target.toLowerCase());
function matchingObject(model: Object3D, target: string, suffix?: string): Object3D | undefined {
  let found: Object3D | undefined;
  model.traverse(object => { if (!found && matches(object.name, target, suffix)) found = object; });
  return found;
}
function matchingCandidates(model: Object3D, targets: string[], suffix?: string) { for (const target of targets) { const object = matchingObject(model, target, suffix); if (object) return object; } }

/** Reduce scene objects to a world-space annotation anchor; numeric camera math stays in Rust. */
export function resolveFaceCenter(model: Object3D, region: Region, profile?: BoneResolutionProfile | null) {
  model.updateMatrixWorld(true);
  const box = new Box3().setFromObject(model); const size = box.getSize(new Vector3());
  const suffix = profile?.suffixPattern;
  const heads = resolveBoneNames(region.bones, profile).filter(name => name.toLowerCase().includes('head'));
  const head = matchingCandidates(model, heads.length ? heads : ['CC_Base_Head', 'Head', 'head', 'Bip01_Head'], suffix);
  const left = matchingCandidates(model, ['CC_Base_L_Eye', 'LeftEye', 'Eye_L', 'L_Eye'], suffix);
  const right = matchingCandidates(model, ['CC_Base_R_Eye', 'RightEye', 'Eye_R', 'R_Eye'], suffix);
  const meshBox = new Box3();
  if (region.meshes?.length) model.traverse(object => { if ((object as any).isMesh && region.meshes!.some(name => matches(object.name, name, suffix))) { const b = new Box3().setFromObject(object); if (!b.isEmpty()) meshBox.union(b); } });
  if (!meshBox.isEmpty() && meshBox.getSize(new Vector3()).y <= size.y * 0.7) return { center: meshBox.getCenter(new Vector3()), method: 'mesh-center', debugInfo: [] as string[] };
  const headBonePosition = head?.getWorldPosition(new Vector3());
  if (left && right) return { center: left.getWorldPosition(new Vector3()).add(right.getWorldPosition(new Vector3())).multiplyScalar(0.5), headBonePosition, method: 'head-bone-offset', debugInfo: [] as string[] };
  if (headBonePosition) return { center: headBonePosition.clone().addScaledVector(toWorldDirection(model, new Vector3(0, 0, 1)), 0.08 * size.y / 1.8), headBonePosition, method: 'head-bone-offset', debugInfo: [] as string[] };
  const center = box.getCenter(new Vector3()); center.y = box.min.y + size.y * 0.9;
  return { center, method: 'fallback', debugInfo: [] as string[] };
}
export function detectAnnotationLaterality(model: Object3D | null, regions: Region[], profile: BoneResolutionProfile | null): AnnotationLaterality {
  if (!model || !regions.length) return getDefaultAnnotationLaterality();
  model.updateMatrixWorld(true); let signed = 0; let total = 0;
  for (const region of regions) {
    const side = semanticSide(region.name); if (!side) continue;
    const object = matchingCandidates(model, resolveBoneNames(region.bones, profile), profile?.suffixPattern); if (!object) continue;
    const x = model.worldToLocal(object.getWorldPosition(new Vector3())).x;
    if (Math.abs(x) > 0.001) { signed += side === 'left' ? x : -x; total += Math.abs(x); }
  }
  return total > 0 ? { leftSideX: signed > 0 ? 1 : -1, confidence: Math.abs(signed) / total, evidence: [] } : getDefaultAnnotationLaterality();
}
