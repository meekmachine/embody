/**
 * Typed wrapper around the Rust/Wasm DPthree annotation camera + marker core.
 *
 * The Rust side owns the pure math (region framing, camera flight/orbit
 * animation, marker visibility gating, viewport line clipping, leader-line
 * curve sampling, and show/hide animation curves). Hosts keep scene-graph
 * work (bounding boxes, OrbitControls, meshes/materials/DOM) and feed packed
 * floats through this wrapper.
 */
import { initEmbodyCore } from '../wasm';
import type {
  EmbodyCoreWasmModule,
  WasmCameraFlightHandle,
  WasmCameraOrbitHandle,
} from '../wasmTypes';

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export interface QuatLike {
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface BoundsLike {
  center: Vec3Like;
  size: Vec3Like;
}

export interface CameraFramingResult {
  position: Vec3Like;
  target: Vec3Like;
  distance: number;
}

export interface CameraPoseSample extends Omit<CameraFramingResult, 'distance'> {
  done: boolean;
}

export interface FocusFramingOptions {
  focusBounds: BoundsLike;
  modelBounds?: BoundsLike | null;
  modelQuaternion?: QuatLike | null;
  fovDegrees: number;
  aspect: number;
  minDistance: number;
  closeUpPaddingFactor: number;
  zoomPaddingFactor: number;
  fullBodyPaddingFactor: number;
  overridePadding?: number;
  cameraAngle?: number;
  angleSpace?: 'model' | 'world';
}

export interface FullBodyFramingOptions {
  boxMin: Vec3Like;
  boxMax: Vec3Like;
  modelQuaternion?: QuatLike | null;
  fovDegrees: number;
  aspect: number;
  minDistance: number;
  fullBodyPaddingFactor: number;
  overridePadding?: number;
  cameraAngle?: number;
  angleSpace?: 'model' | 'world';
}

export type MarkerSoloState = 'none' | 'soloed' | 'other-soloed';

export interface MarkerVisibilityAnimationFactors {
  itemOpacityFactor: number;
  labelScaleFactor: number;
  lineOpacityFactor: number;
}

export interface MarkerEndpointSeparationOptions {
  /** Packed marker surface anchors as `[x, y, z, ...]`. */
  starts: readonly number[];
  /** Packed marker leader-line ends as `[x, y, z, ...]`. */
  ends: readonly number[];
  modelCenter: Vec3Like;
  modelHeight: number;
}

function packVec3(value: Vec3Like): Float32Array {
  return new Float32Array([value.x, value.y, value.z]);
}

function packBounds(bounds: BoundsLike | null | undefined): Float32Array {
  if (!bounds) return new Float32Array(0);
  return new Float32Array([
    bounds.center.x,
    bounds.center.y,
    bounds.center.z,
    bounds.size.x,
    bounds.size.y,
    bounds.size.z,
  ]);
}

function packQuat(quat: QuatLike | null | undefined): Float32Array {
  if (!quat) return new Float32Array(0);
  return new Float32Array([quat.x, quat.y, quat.z, quat.w]);
}

function unpackFraming(values: Float32Array): CameraFramingResult {
  return {
    position: { x: values[0], y: values[1], z: values[2] },
    target: { x: values[3], y: values[4], z: values[5] },
    distance: values[6],
  };
}

function unpackPoseSample(values: Float32Array): CameraPoseSample {
  return {
    position: { x: values[0], y: values[1], z: values[2] },
    target: { x: values[3], y: values[4], z: values[5] },
    done: values[6] >= 1,
  };
}

function soloStateToCode(state: MarkerSoloState): number {
  if (state === 'soloed') return 1;
  if (state === 'other-soloed') return 2;
  return 0;
}

export class RustCameraFlight {
  private handle: WasmCameraFlightHandle;

  constructor(handle: WasmCameraFlightHandle) {
    this.handle = handle;
  }

  sample(elapsedMs: number): CameraPoseSample {
    return unpackPoseSample(this.handle.sample(elapsedMs));
  }

  get durationMs(): number {
    return this.handle.duration_ms();
  }

  dispose(): void {
    this.handle.free?.();
  }
}

export class RustCameraOrbit {
  private handle: WasmCameraOrbitHandle;

  constructor(handle: WasmCameraOrbitHandle) {
    this.handle = handle;
  }

  sample(elapsedMs: number): CameraPoseSample {
    return unpackPoseSample(this.handle.sample(elapsedMs));
  }

  get durationMs(): number {
    return this.handle.duration_ms();
  }

  dispose(): void {
    this.handle.free?.();
  }
}

export class RustAnnotationCameraCore {
  private core: EmbodyCoreWasmModule;

  private constructor(core: EmbodyCoreWasmModule) {
    this.core = core;
  }

  static async create(): Promise<RustAnnotationCameraCore> {
    return new RustAnnotationCameraCore(await initEmbodyCore());
  }

  // ====== CAMERA MATH ======

  normalizeCameraAngle(angle: number): number {
    return this.core.normalize_camera_angle_degrees(angle);
  }

  worldDirectionForCameraAngle(modelQuaternion: QuatLike | null, cameraAngle: number): Vec3Like {
    const values = this.core.world_direction_for_camera_angle(packQuat(modelQuaternion), cameraAngle);
    return { x: values[0], y: values[1], z: values[2] };
  }

  resolveFocusCameraDirection(
    modelQuaternion: QuatLike | null,
    effectiveAngle: number,
    cameraAngle: number | undefined,
    angleSpace: 'model' | 'world' = 'model',
  ): Vec3Like {
    const values = this.core.resolve_focus_camera_direction(
      packQuat(modelQuaternion),
      effectiveAngle,
      cameraAngle !== undefined,
      angleSpace === 'world',
    );
    return { x: values[0], y: values[1], z: values[2] };
  }

  resolveAutoCloseupAngle(
    horizontalOffset: number,
    focusSize: Vec3Like,
    modelSize: Vec3Like,
  ): number | undefined {
    return this.core.resolve_auto_closeup_angle(
      horizontalOffset,
      packVec3(focusSize),
      packVec3(modelSize),
    );
  }

  focusPaddingFactor(
    size: number,
    closeUpPaddingFactor: number,
    zoomPaddingFactor: number,
    fullBodyPaddingFactor: number,
  ): number {
    return this.core.focus_padding_factor(
      size,
      closeUpPaddingFactor,
      zoomPaddingFactor,
      fullBodyPaddingFactor,
    );
  }

  solveFocusFraming(options: FocusFramingOptions): CameraFramingResult {
    return unpackFraming(this.core.solve_focus_framing(
      packBounds(options.focusBounds),
      packBounds(options.modelBounds),
      packQuat(options.modelQuaternion),
      options.fovDegrees,
      options.aspect,
      options.minDistance,
      options.closeUpPaddingFactor,
      options.zoomPaddingFactor,
      options.fullBodyPaddingFactor,
      options.overridePadding,
      options.cameraAngle,
      options.angleSpace === 'world',
    ));
  }

  solveFullBodyFraming(options: FullBodyFramingOptions): CameraFramingResult {
    return unpackFraming(this.core.solve_full_body_framing(
      packVec3(options.boxMin),
      packVec3(options.boxMax),
      packQuat(options.modelQuaternion),
      options.fovDegrees,
      options.aspect,
      options.minDistance,
      options.fullBodyPaddingFactor,
      options.overridePadding,
      options.cameraAngle,
      options.angleSpace === 'world',
    ));
  }

  // ====== CAMERA ANIMATION ======

  createCameraFlight(
    startPosition: Vec3Like,
    startTarget: Vec3Like,
    endPosition: Vec3Like,
    endTarget: Vec3Like,
    durationMs: number,
  ): RustCameraFlight {
    return new RustCameraFlight(new this.core.CameraFlight(
      packVec3(startPosition),
      packVec3(startTarget),
      packVec3(endPosition),
      packVec3(endTarget),
      durationMs,
    ));
  }

  createCameraOrbit(
    center: Vec3Like,
    radius: number,
    height: number,
    durationMs: number,
  ): RustCameraOrbit {
    return new RustCameraOrbit(new this.core.CameraOrbit(
      packVec3(center),
      radius,
      height,
      durationMs,
    ));
  }

  // ====== MARKERS ======

  passesMarkerCameraAngleGate(params: {
    markerAngle?: number;
    currentCameraAngle?: number;
    rangeDegrees?: number;
  }): boolean {
    return this.core.passes_marker_camera_angle_gate(
      params.markerAngle,
      params.currentCameraAngle,
      params.rangeDegrees,
    );
  }

  shouldShowMarker(params: {
    hiddenChild: boolean;
    solo: MarkerSoloState;
    markerAngle?: number;
    currentCameraAngle?: number;
  }): boolean {
    return this.core.should_show_marker(
      params.hiddenChild,
      soloStateToCode(params.solo),
      params.markerAngle,
      params.currentCameraAngle,
    );
  }

  resolveViewportConstrainedLineScale(params: {
    startClip: readonly number[];
    endClip: readonly number[];
    safeX: number;
    safeY: number;
    minLengthRatio?: number;
  }): { visible: boolean; lineScale: number } {
    const result = this.core.resolve_viewport_constrained_line_scale(
      new Float32Array(params.startClip),
      new Float32Array(params.endClip),
      params.safeX,
      params.safeY,
      params.minLengthRatio,
    );
    return { visible: result[0] >= 1, lineScale: result[1] };
  }

  resolveViewportSafeBounds(params: {
    labelScaleX: number;
    labelScaleY: number;
    projectionXScale: number;
    projectionYScale: number;
    viewportWidth: number;
    viewportHeight: number;
    edgePaddingPx?: number;
  }): { safeX: number; safeY: number } {
    const result = this.core.resolve_viewport_safe_bounds(
      params.labelScaleX,
      params.labelScaleY,
      params.projectionXScale,
      params.projectionYScale,
      params.viewportWidth,
      params.viewportHeight,
      params.edgePaddingPx,
    );
    return { safeX: result[0], safeY: result[1] };
  }

  /** Returns `(segments + 1)` points as a flat `[x, y, z, ...]` array. */
  sampleMarkerBezierCurve(start: Vec3Like, end: Vec3Like, segments = 16): Float32Array {
    return this.core.sample_marker_bezier_curve(packVec3(start), packVec3(end), segments);
  }

  /** Returns `(segments + 1)` points as a flat `[x, y, z, ...]` array. */
  sampleMarkerArcCurve(start: Vec3Like, end: Vec3Like, segments = 16): Float32Array {
    return this.core.sample_marker_arc_curve(packVec3(start), packVec3(end), segments);
  }

  markerVisibilityAnimationFactors(visible: boolean, t: number): MarkerVisibilityAnimationFactors {
    const values = this.core.marker_visibility_animation_factors(visible, t);
    return {
      itemOpacityFactor: values[0],
      labelScaleFactor: values[1],
      lineOpacityFactor: values[2],
    };
  }

  /**
   * Separates overlapping leader-line endpoints while retaining marker anchors
   * and leader-line lengths. Returns packed `[x, y, z, ...]` end points.
   */
  separateOverlappingMarkerEndpoints(options: MarkerEndpointSeparationOptions): Float32Array {
    return this.core.separate_overlapping_marker_endpoints(
      new Float32Array(options.starts),
      new Float32Array(options.ends),
      packVec3(options.modelCenter),
      options.modelHeight,
    );
  }
}

export async function createRustAnnotationCameraCore(): Promise<RustAnnotationCameraCore> {
  return RustAnnotationCameraCore.create();
}
