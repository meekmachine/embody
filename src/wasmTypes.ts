export interface WasmHairPhysicsSolver {
  update(dtSeconds: number, headValues: Float32Array): Float32Array;
  set_config(configValues: Float32Array): void;
  get_config(): Float32Array;
  get_state(): Float32Array;
  reset(): void;
  free?: () => void;
}

export interface WasmHairPhysicsSolverConstructor {
  new(configValues: Float32Array): WasmHairPhysicsSolver;
}

export interface WasmRuntimeCoreHandle {
  configure(profileJson: string, modelJson: string): void;
  viseme_slot_index(slotId: string): number;
  set_au_signed(id: number, value: number, balance: number): void;
  set_continuum(negAu: number, posAu: number, value: number, balance: number): void;
  get_continuum(negAu: number, posAu: number): number;
  transition_au(id: number, to: number, durationMs: number, balance: number): void;
  transition_viseme(index: number, to: number, durationMs: number, jawScale: number): void;
  update(dtSeconds: number): number;
  active_transition_count(): number;
  clear_transitions(): void;
  load_au_morph_bindings(values: Float32Array): void;
  load_viseme_morph_bindings(values: Float32Array): void;
  load_bone_rest_transforms(values: Float32Array): void;
  load_composite_axes(values: Float32Array): void;
  load_bone_translations(values: Float32Array): void;
  load_jaw_binding(values: Float32Array): void;
  load_viseme_jaw_amounts(values: Float32Array): void;
  set_mixed_aus(ids: Uint32Array): void;
  set_au(id: number, value: number, balance: number): void;
  get_au(id: number): number;
  set_au_mix_weight(id: number, weight: number): void;
  set_viseme(index: number, value: number): void;
  set_viseme_jaw_scale(index: number, jawScale: number): void;
  set_viseme_slot_count(count: number): void;
  clear(): void;
  evaluate_morph_frame_delta(): Float32Array;
  evaluate_bone_frame_delta(): Float32Array;
  free?: () => void;
}

export interface WasmRuntimeCoreConstructor {
  new(visemeSlotCount: number): WasmRuntimeCoreHandle;
  au_morph_binding_stride(): number;
  viseme_morph_binding_stride(): number;
}

export interface WasmCameraFlightHandle {
  /** Returns `[posX, posY, posZ, targetX, targetY, targetZ, done]`. */
  sample(elapsedMs: number): Float32Array;
  duration_ms(): number;
  free?: () => void;
}

export interface WasmCameraFlightConstructor {
  new(
    startPosition: Float32Array,
    startTarget: Float32Array,
    endPosition: Float32Array,
    endTarget: Float32Array,
    durationMs: number
  ): WasmCameraFlightHandle;
}

export interface WasmCameraOrbitHandle {
  /** Returns `[posX, posY, posZ, targetX, targetY, targetZ, done]`. */
  sample(elapsedMs: number): Float32Array;
  duration_ms(): number;
  free?: () => void;
}

export interface WasmCameraOrbitConstructor {
  new(
    center: Float32Array,
    radius: number,
    height: number,
    durationMs: number
  ): WasmCameraOrbitHandle;
}

export interface EmbodyCoreWasmModule {
  default?: (moduleOrPath?: unknown) => Promise<unknown> | unknown;
  core_abi_version(): number;
  packed_morph_frame_delta_stride(): number;
  packed_bone_frame_delta_stride(): number;
  pack_morph_frame_delta(
    meshIds: Uint32Array,
    morphTargetIds: Uint32Array,
    values: Float32Array,
    modes: Uint8Array
  ): Float32Array;
  solve_bilateral_values(base: number, balance: number): Float32Array;
  solve_morph_batch(values: Float32Array, balances: Float32Array, mixWeights: Float32Array): Float32Array;
  solve_axis_quaternion(axis: number, degrees: number, value: number, scale: number): Float32Array;
  mesh_proportions_stride(): number;
  template_skeleton_fit_solution_stride(): number;
  analyze_mesh_proportions(vertices: Float32Array, verticalAxis: number): Float32Array;
  solve_template_skeleton_fit(
    meshVertices: Float32Array,
    templateBounds: Float32Array,
    verticalAxis: number,
    verticalAnchor: number
  ): Float32Array;
  compose_template_fit_adjustment(
    fit: Float32Array,
    scaleMultiplier: number,
    offsetX: number,
    offsetY: number,
    offsetZ: number
  ): Float32Array;
  hair_config_stride(): number;
  hair_state_stride(): number;
  hair_head_state_stride(): number;
  hair_morph_output_stride(): number;
  template_skeleton_fit_transform_stride(): number;
  compose_template_skeleton_fit_transform(
    fitScale: number,
    fitTranslation: Float32Array,
    manualScale: number,
    manualTranslation: Float32Array
  ): Float32Array;
  default_hair_physics_config_values(): Float32Array;
  merge_preset_profile(baseJson: string, extensionJson: string): string;
  compile_clip(inputJson: string): string;
  compile_clip_curves(inputJson: string): string;
  build_hair_idle_curves(configJson: string, durationSec: number): string;
  build_hair_impulse_curves(
    configJson: string,
    durationSec: number,
    horizontal: number,
    vertical: number
  ): string;
  build_hair_gravity_curves(configJson: string): string;
  annotation_camera_framing_stride(): number;
  camera_flight_sample_stride(): number;
  marker_visibility_factors_stride(): number;
  marker_endpoint_stride(): number;
  normalize_camera_angle_degrees(angle: number): number;
  world_direction_for_camera_angle(modelQuat: Float32Array, cameraAngle: number): Float32Array;
  resolve_focus_camera_direction(
    modelQuat: Float32Array,
    effectiveAngle: number,
    hasExplicitAngle: boolean,
    worldAngleSpace: boolean
  ): Float32Array;
  resolve_auto_closeup_angle(
    horizontalOffset: number,
    focusSize: Float32Array,
    modelSize: Float32Array
  ): number | undefined;
  focus_padding_factor(
    size: number,
    closeUpPadding: number,
    zoomPadding: number,
    fullBodyPadding: number
  ): number;
  solve_focus_framing(
    focusBounds: Float32Array,
    modelBounds: Float32Array,
    modelQuat: Float32Array,
    fovDeg: number,
    aspect: number,
    minDistance: number,
    closeUpPadding: number,
    zoomPadding: number,
    fullBodyPadding: number,
    overridePadding: number | undefined,
    cameraAngle: number | undefined,
    worldAngleSpace: boolean
  ): Float32Array;
  solve_full_body_framing(
    boxMin: Float32Array,
    boxMax: Float32Array,
    modelQuat: Float32Array,
    fovDeg: number,
    aspect: number,
    minDistance: number,
    fullBodyPadding: number,
    overridePadding: number | undefined,
    cameraAngle: number | undefined,
    worldAngleSpace: boolean
  ): Float32Array;
  passes_marker_camera_angle_gate(
    markerAngle: number | undefined,
    currentCameraAngle: number | undefined,
    rangeDegrees: number | undefined
  ): boolean;
  should_show_marker(
    hiddenChild: boolean,
    soloed: number,
    markerAngle: number | undefined,
    currentCameraAngle: number | undefined
  ): boolean;
  resolve_viewport_constrained_line_scale(
    startClip: Float32Array,
    endClip: Float32Array,
    safeX: number,
    safeY: number,
    minLengthRatio: number | undefined
  ): Float32Array;
  resolve_viewport_safe_bounds(
    labelScaleX: number,
    labelScaleY: number,
    projectionXScale: number,
    projectionYScale: number,
    viewportWidth: number,
    viewportHeight: number,
    edgePaddingPx: number | undefined
  ): Float32Array;
  sample_marker_bezier_curve(start: Float32Array, end: Float32Array, segments: number): Float32Array;
  sample_marker_arc_curve(start: Float32Array, end: Float32Array, segments: number): Float32Array;
  marker_visibility_animation_factors(visible: boolean, t: number): Float32Array;
  separate_overlapping_marker_endpoints(
    starts: Float32Array,
    ends: Float32Array,
    modelCenter: Float32Array,
    modelHeight: number
  ): Float32Array;
  HairPhysicsSolver: WasmHairPhysicsSolverConstructor;
  RuntimeCore: WasmRuntimeCoreConstructor;
  CameraFlight: WasmCameraFlightConstructor;
  CameraOrbit: WasmCameraOrbitConstructor;
}
