/* tslint:disable */
/* eslint-disable */

/**
 * Spherical camera flight between two camera poses.
 *
 * Mirrors the DPthree camera transition: orbital interpolation with a
 * pullback arc so large rotations do not pass through the model.
 * `sample(elapsed_ms)` returns
 * `[posX, posY, posZ, targetX, targetY, targetZ, done]`.
 */
export class CameraFlight {
    free(): void;
    [Symbol.dispose](): void;
    duration_ms(): number;
    constructor(start_position: Float32Array, start_target: Float32Array, end_position: Float32Array, end_target: Float32Array, duration_ms: number);
    sample(elapsed_ms: number): Float32Array;
}

/**
 * Full 360-degree eased orbit around a center point.
 * `sample(elapsed_ms)` returns
 * `[posX, posY, posZ, targetX, targetY, targetZ, done]`.
 */
export class CameraOrbit {
    free(): void;
    [Symbol.dispose](): void;
    duration_ms(): number;
    constructor(center: Float32Array, radius: number, height: number, duration_ms: number);
    sample(elapsed_ms: number): Float32Array;
}

export class HairPhysicsSolver {
    free(): void;
    [Symbol.dispose](): void;
    get_config(): Float32Array;
    get_state(): Float32Array;
    constructor(config_values: Float32Array);
    reset(): void;
    set_config(config_values: Float32Array): void;
    update(dt: number, head_values: Float32Array): Float32Array;
}

/**
 * Host-neutral live morph runtime. Owns AU/viseme/mix state and emits packed
 * morph frame deltas. Engine objects never enter this struct.
 */
export class RuntimeCore {
    free(): void;
    [Symbol.dispose](): void;
    active_transition_count(): number;
    static au_morph_binding_stride(): number;
    build_clip(clip_name: string, curves_json: string, options_json: string): string;
    build_typed_clip(clip_name: string, channels_json: string, options_json: string): string;
    cleanup_snippet(clip_name: string): boolean;
    clear(): void;
    clear_transitions(): void;
    /**
     * Configure the core from the profile and model descriptor JSON hosts
     * already have. All binding compilation (mesh/morph/bone name resolution,
     * composite axes, translations, jaw, viseme slots, mix defaults,
     * continuum pairs) happens here, inside the core.
     */
    configure(profile_json: string, model_json: string): void;
    /**
     * Configure from an embedded preset id + optional override JSON + model
     * descriptor JSON. The CC4 (etc.) preset data lives in the Wasm core;
     * hosts only pass the preset id and overrides.
     */
    configure_with_preset(preset_id: string, override_json: string, model_json: string): void;
    /**
     * Configure from a resolved profile without applying an embedded preset.
     *
     * The profile must contain runtime mappings, but mappings that do not match
     * the current model are non-fatal. The character can still render and be
     * repaired in the authoring UI without silently substituting a preset.
     */
    configure_with_profile(profile_json: string, model_json: string): void;
    /**
     * Host-owned crossfade marker. Rust does not lerp; the host mixer should fade.
     */
    crossfade_to(clip_name: string, _duration: number, options_json: string): string;
    drain_animation_events(): string;
    /**
     * Same rows as `evaluate_bone_frame_delta`, but only bones an active AU,
     * translation, or viseme jaw value is currently rotating or moving.
     * Neutral bones are omitted (no rest reset), so hosts can re-apply this
     * after mixer playback without freezing clip-driven bones (Loom3 parity).
     */
    evaluate_active_bone_frame(): Float32Array;
    /**
     * Same rows as `evaluate_morph_frame_delta`, but only channels with a
     * non-zero live value. Hosts re-apply this after mixer playback so live
     * AU/viseme state wins over clip tracks (Loom3 parity) without resetting
     * channels the mixer owns.
     */
    evaluate_active_morph_frame(): Float32Array;
    /**
     * Packed bone FrameDelta rows: `[bone_id, px, py, pz, qx, qy, qz, qw, flags] * N`
     * flags: bit0 = has_position, bit1 = has_rotation. Composite rotations are
     * relative to rest, AU-driven translations are added to rest position, and
     * viseme jaw rotation is applied as an absolute packed frame write.
     */
    evaluate_bone_frame_delta(): Float32Array;
    /**
     * Packed morph FrameDelta rows: `[mesh_id, morph_target_id, value, mode] * N`
     * Live AU/viseme/direct morph state only — clip playback is host-owned.
     */
    evaluate_morph_frame_delta(): Float32Array;
    /**
     * Scene extras for live state. Clip-driven scale/visibility/object writes
     * are owned by the host mixer, so this returns an empty frame.
     */
    evaluate_scene_frame(): string;
    get_animation_clips(): string;
    get_animation_state(clip_name: string): string;
    get_au(id: number): number;
    get_continuum(neg_au: number, pos_au: number): number;
    get_playing_animations(): string;
    load_animation_clips(clips_json: string): void;
    /**
     * Packed rows: `[au_id, side, mesh_id, morph_target_id, weight] * N`
     * side: 0=left, 1=right, 2=center
     */
    load_au_morph_bindings(values: Float32Array): void;
    /**
     * Packed rows: `[bone_id, px, py, pz, qx, qy, qz, qw] * N`
     */
    load_bone_rest_transforms(values: Float32Array): void;
    /**
     * Packed rows: `[au_id, bone_id, axis(0=x,1=y,2=z), scale, max_units] * N`
     */
    load_bone_translations(values: Float32Array): void;
    /**
     * Variable-length blocks, one per composite axis:
     * header `[bone_id, axis, has_directional, value_rows, binding_rows, 0, 0, 0]`,
     * then value rows `[au_id, group, side] * value_rows`,
     * then binding rows `[au_id, group, side, channel, scale, max_degrees] * binding_rows`.
     * Axes must be packed grouped per bone in application order (yaw, pitch, roll).
     */
    load_composite_axes(values: Float32Array): void;
    /**
     * Packed row: `[bone_id, channel, scale, max_degrees]`; empty slice clears.
     */
    load_jaw_binding(values: Float32Array): void;
    load_viseme_jaw_amounts(values: Float32Array): void;
    /**
     * Packed rows: `[viseme_index, mesh_id, morph_target_id, weight] * N`
     */
    load_viseme_morph_bindings(values: Float32Array): void;
    constructor(viseme_slot_count: number);
    pause_all_animations(): void;
    pause_animation(clip_name: string): void;
    /**
     * Registry lookup only. Host animation libraries own play/lerp; this returns
     * a host-owned action id marker when the clip exists in the registry.
     */
    play_animation(clip_name: string, _options_json: string): string;
    play_snippet(clip_name: string, curves_json: string, options_json: string): string;
    play_typed_snippet(clip_name: string, channels_json: string, options_json: string): string;
    register_animation_clip(clip_json: string, source: string): void;
    remove_animation_clip(clip_name: string): boolean;
    resume_all_animations(): void;
    resume_animation(clip_name: string): void;
    seek_animation(clip_name: string, time: number): void;
    set_animation_blend_mode(clip_name: string, blend_mode: string): void;
    set_animation_intensity(clip_name: string, intensity: number): void;
    set_animation_loop_mode(clip_name: string, loop_mode: string): void;
    set_animation_repeat_count(clip_name: string, repeat_count: number): void;
    set_animation_reverse(clip_name: string, reverse: boolean): void;
    set_animation_speed(clip_name: string, speed: number): void;
    set_animation_time_scale(time_scale: number): void;
    set_au(id: number, value: number, balance: number): void;
    set_au_mix_weight(id: number, weight: number): void;
    /**
     * Continuum-aware AU set. Negative values route through the configured
     * continuum pair (e.g. eyes left/right) exactly like the legacy runtime.
     */
    set_au_signed(id: number, value: number, balance: number): void;
    set_continuum(neg_au: number, pos_au: number, value: number, balance: number): void;
    set_mixed_aus(ids: Uint32Array): void;
    set_morph(morph_name: string, value: number, mesh_names_json: string): number;
    set_morph_index(morph_index: number, value: number, mesh_names_json: string): number;
    set_viseme(index: number, value: number): void;
    set_viseme_jaw_scale(index: number, jaw_scale: number): void;
    set_viseme_slot_count(count: number): void;
    stop_all_animations(): void;
    stop_animation(clip_name: string): void;
    /**
     * Set an AU immediately. Duration is ignored — host mixers own timed fades.
     */
    transition_au(id: number, to: number, _duration_ms: number, balance: number): void;
    /**
     * Set morph(s) immediately. Duration is ignored — host mixers own timed fades.
     */
    transition_morph(morph_name: string, to: number, _duration_ms: number, mesh_names_json: string): number;
    /**
     * Set morph index target(s) immediately. Duration is ignored.
     */
    transition_morph_index(morph_index: number, to: number, _duration_ms: number, mesh_names_json: string): number;
    /**
     * Set a viseme immediately. Duration is ignored — host mixers own timed fades.
     */
    transition_viseme(index: number, to: number, _duration_ms: number, jaw_scale: number): void;
    /**
     * Tick hook for hosts. Clip playback/lerp lives in the host animation
     * library; Rust only exposes live AU/viseme state for packed frames.
     */
    update(_dt_seconds: number): number;
    update_clip_params(clip_name: string, params_json: string): boolean;
    static viseme_morph_binding_stride(): number;
    viseme_slot_index(slot_id: string): number;
}

/**
 * Analyze xyz vertex positions for a rough humanoid proportion signal.
 *
 * Input is a packed xyz buffer. `vertical_axis` is 0 for x, 1 for y, and 2 for z.
 * Invalid or incomplete vertices are ignored.
 *
 * Output layout:
 * [min_x, min_y, min_z, max_x, max_y, max_z,
 *  center_x, center_y, center_z,
 *  span_x, span_y, span_z,
 *  vertical_height, cross_axis_wide_span, cross_axis_narrow_span,
 *  humanoid_likelihood]
 */
export function analyze_mesh_proportions(vertices: Float32Array, vertical_axis: number): Float32Array;

export function analyze_model_descriptor(model_json: string, clips_json: string, profile_json: string, options_json: string): string;

export function annotation_camera_framing_stride(): number;

/**
 * Build head-pitch gravity hair morph curves.
 */
export function build_hair_gravity_curves(config_json: string): string;

/**
 * Build idle/wind hair morph curves (JSON map of morphKey -> [{time,intensity}]).
 */
export function build_hair_idle_curves(config_json: string, duration_sec: number): string;

/**
 * Build a directional hair impulse curve set.
 */
export function build_hair_impulse_curves(config_json: string, duration_sec: number, horizontal: number, vertical: number): string;

export function camera_flight_sample_stride(): number;

/**
 * Compile a clip track input (JSON) into host-neutral ClipIR JSON.
 */
export function compile_clip(input_json: string): string;

/**
 * Compile named intensity curves (JSON) into host-neutral ClipIR JSON.
 */
export function compile_clip_curves(input_json: string): string;

/**
 * Compose user-facing manual adjustments onto a solved skeleton fit.
 *
 * `fit` must start with [scale, translate_x, translate_y, translate_z]. The
 * output preserves those four fields after multiplying scale and adding offsets.
 */
export function compose_template_fit_adjustment(fit: Float32Array, scale_multiplier: number, offset_x: number, offset_y: number, offset_z: number): Float32Array;

export function compose_template_skeleton_fit_transform(fit_scale: number, fit_translation: Float32Array, manual_scale: number, manual_translation: Float32Array): Float32Array;

export function compute_humanoid_skeleton_template_rest_bounds(template_json: string): Float64Array;

export function core_abi_version(): number;

export function create_validation_skeleton_json(template_json: string): string;

export function default_hair_color_appearance_json(): string;

export function default_hair_physics_config_values(): Float32Array;

/**
 * Execute a host-neutral Embody operation using JSON in and JSON out.
 * This keeps CLJS and other browser hosts off the Rust data structures while
 * ensuring all profile semantics execute inside Wasm.
 */
export function embody_request(request_json: string): string;

export function extract_humanoid_skeleton_template_json(model_json: string, options_json: string): string;

export function extract_model_data_json(model_json: string, clips_json: string): string;

/**
 * Padding factor for a focus target of the given max dimension.
 */
export function focus_padding_factor(size: number, close_up_padding: number, zoom_padding: number, full_body_padding: number): number;

export function get_humanoid_skeleton_template_json(id: string): string;

/**
 * Return the embedded preset JSON for a preset id (intake source of truth).
 */
export function get_preset_json(preset_id: string): string;

export function hair_color_presets_json(): string;

export function hair_config_stride(): number;

export function hair_head_state_stride(): number;

export function hair_morph_output_stride(): number;

export function hair_state_stride(): number;

/**
 * True when the Wasm core ships the given preset id.
 */
export function has_preset(preset_id: string): boolean;

export function humanoid_skeleton_template_bone_names(template_json: string): string;

export function list_humanoid_skeleton_templates_json(): string;

/**
 * Canonical embedded preset ids available inside the Wasm core.
 */
export function list_presets(): string[];

export function marker_endpoint_stride(): number;

/**
 * Marker show/hide animation factors at normalized time `t` in `[0, 1]`.
 * Returns `[itemOpacityFactor, labelScaleFactor, lineOpacityFactor]`.
 */
export function marker_visibility_animation_factors(visible: boolean, t: number): Float32Array;

export function marker_visibility_factors_stride(): number;

/**
 * Merge overrides onto an embedded preset. Hosts that still need a JS Profile
 * object for Mixer callbacks can use this; the runtime configure path should
 * prefer `RuntimeCore.configure_with_preset`.
 */
export function merge_embedded_preset(preset_id: string, override_json: string): string;

/**
 * Merge a base preset profile with an extension profile (both JSON strings)
 * using the engine's preset extension rules. Returns the merged profile JSON.
 */
export function merge_preset_profile(base_json: string, extension_json: string): string;

export function mesh_proportions_stride(): number;

export function normalize_camera_angle_degrees(angle: number): number;

export function normalize_hair_color_appearance_json(value_json: string, fallback_json: string): string;

export function pack_morph_frame_delta(mesh_ids: Uint32Array, morph_target_ids: Uint32Array, values: Float32Array, modes: Uint8Array): Float32Array;

export function packed_bone_frame_delta_stride(): number;

export function packed_morph_frame_delta_stride(): number;

/**
 * Whether a marker with a preferred viewing angle should show for the
 * current camera orbit angle. Angles are degrees around the model Y axis.
 */
export function passes_marker_camera_angle_gate(marker_angle?: number | null, current_camera_angle?: number | null, range_degrees?: number | null): boolean;

/**
 * Auto camera angle for small offset focus targets (eye closeups).
 * Returns `undefined` when no auto angle applies.
 */
export function resolve_auto_closeup_angle(horizontal_offset: number, focus_size: Float32Array, model_size: Float32Array): number | undefined;

/**
 * Merge an embedded preset with sparse overrides, then return the resolved
 * routing/metadata view for host adapters.
 */
export function resolve_embedded_profile_view(preset_id: string, override_json: string): string;

/**
 * Direction the camera should approach from when focusing a region.
 */
export function resolve_focus_camera_direction(model_quat: Float32Array, effective_angle: number, has_explicit_angle: boolean, world_angle_space: boolean): Float32Array;

/**
 * Resolve profile routing/metadata answers that hosts need without making
 * hosts duplicate profile semantics in JavaScript.
 */
export function resolve_profile_view(profile_json: string): string;

/**
 * Clip a marker leader line (clip-space start/end, `[x, y, z, w]` each) to a
 * safe viewport rectangle. Returns `[visible, lineScale]` where `lineScale`
 * is the fraction of the line that stays on screen.
 */
export function resolve_viewport_constrained_line_scale(start_clip: Float32Array, end_clip: Float32Array, safe_x: number, safe_y: number, min_length_ratio?: number | null): Float32Array;

/**
 * Safe NDC bounds that keep a screen-space label plus a pixel gutter fully
 * on screen. Returns `[safeX, safeY]`.
 */
export function resolve_viewport_safe_bounds(label_scale_x: number, label_scale_y: number, projection_x_scale: number, projection_y_scale: number, viewport_width: number, viewport_height: number, edge_padding_px?: number | null): Float32Array;

/**
 * Sinusoidal arc leader line points between two world positions.
 * Returns `(segments + 1) * 3` floats.
 */
export function sample_marker_arc_curve(start: Float32Array, end: Float32Array, segments: number): Float32Array;

/**
 * Quadratic bezier leader line points between two world positions.
 * Returns `(segments + 1) * 3` floats.
 */
export function sample_marker_bezier_curve(start: Float32Array, end: Float32Array, segments: number): Float32Array;

/**
 * Separates overlapping marker endpoints while preserving each marker's
 * surface anchor and leader-line length.
 *
 * `starts` and `ends` are packed `[x, y, z, ...]` arrays. The output includes
 * one endpoint for every complete start/end pair. Proximity and rotation
 * constants match DPthree's marker layout, scaled to the current model height.
 */
export function separate_overlapping_marker_endpoints(starts: Float32Array, ends: Float32Array, model_center: Float32Array, model_height: number): Float32Array;

/**
 * Solo/expand/angle visibility rule for a marker.
 *
 * * `hidden_child` - the marker is a collapsed child of an expandable region.
 * * `soloed` - solo state: 0 = no solo, 1 = this marker is soloed,
 *   2 = another marker is soloed.
 */
export function should_show_marker(hidden_child: boolean, soloed: number, marker_angle?: number | null, current_camera_angle?: number | null): boolean;

export function solve_axis_quaternion(axis: number, degrees: number, value: number, scale: number): Float32Array;

export function solve_bilateral_values(base: number, balance: number): Float32Array;

/**
 * Solve the camera framing for a focus target.
 *
 * * `focus_bounds` - `[centerX, centerY, centerZ, sizeX, sizeY, sizeZ]` of the focus box.
 * * `model_bounds` - same layout for the whole model, or empty when unavailable.
 * * `model_quat` - model world quaternion `[x, y, z, w]`, or empty for identity.
 * * `camera_angle` - explicit region camera angle (degrees), or `undefined`.
 * * `world_angle_space` - whether `camera_angle` is a world-space angle.
 *
 * Returns `[posX, posY, posZ, targetX, targetY, targetZ, distance]`.
 */
export function solve_focus_framing(focus_bounds: Float32Array, model_bounds: Float32Array, model_quat: Float32Array, fov_deg: number, aspect: number, min_distance: number, close_up_padding: number, zoom_padding: number, full_body_padding: number, override_padding: number | null | undefined, camera_angle: number | null | undefined, world_angle_space: boolean): Float32Array;

/**
 * Solve the hero full-body framing.
 *
 * * `box_min` / `box_max` - model bounding box corners.
 *
 * Returns `[posX, posY, posZ, targetX, targetY, targetZ, distance]`.
 */
export function solve_full_body_framing(box_min: Float32Array, box_max: Float32Array, model_quat: Float32Array, fov_deg: number, aspect: number, min_distance: number, full_body_padding: number, override_padding: number | null | undefined, camera_angle: number | null | undefined, world_angle_space: boolean): Float32Array;

export function solve_morph_batch(values: Float32Array, balances: Float32Array, mix_weights: Float32Array): Float32Array;

/**
 * Solve a uniform scale and translation for placing a template skeleton inside a mesh.
 *
 * `template_bounds` is [min_x, min_y, min_z, max_x, max_y, max_z] in the
 * template skeleton's rest-pose coordinate space. `vertical_axis` is 0, 1, or 2.
 * `vertical_anchor` controls vertical placement: 0 aligns mins, 1 aligns centers,
 * 2 aligns maxes.
 *
 * Output layout:
 * [scale, translate_x, translate_y, translate_z,
 *  mesh_humanoid_likelihood, mesh_height, template_height,
 *  mesh_cross_axis_wide_span, template_cross_axis_wide_span, status]
 *
 * `status` is 1 for solved, 0 for invalid mesh input, and -1 for invalid template
 * bounds. This does not compute skin weights, inverse bind matrices, or pose
 * retargeting.
 */
export function solve_template_skeleton_fit(mesh_vertices: Float32Array, template_bounds: Float32Array, vertical_axis: number, vertical_anchor: number): Float32Array;

export function template_skeleton_fit_solution_stride(): number;

export function template_skeleton_fit_transform_stride(): number;

/**
 * Validate generated template skeleton fit metadata from a compact Wasm ABI.
 *
 * String inputs carry host-owned ids. The packed f32 slice layout is:
 * [schema_version, metadata_kind, template_lookup_status, fit_status,
 *  vertical_axis, vertical_anchor, fit_scale, translate_x, translate_y,
 *  translate_z, solver_confidence, manual_scale_multiplier, manual_offset_x,
 *  manual_offset_y, manual_offset_z].
 *
 * `metadata_kind` must be 1, which identifies generated template fit metadata
 * and keeps it separate from imported rig, skinning, or bind-pose data.
 *
 * The return value is a compact bitmask. 0 means valid.
 */
export function validate_generated_template_fit_metadata(template_id: string, source_character_id: string, metadata: Float32Array): number;

/**
 * Validate an authored profile against a renderer-neutral model descriptor.
 * Three.js objects are reduced to this descriptor by the thin host adapter;
 * all mapping analysis and correction generation stays in Rust.
 */
export function validate_profile_model(profile_json: string, model_json: string, options_json: string): string;

/**
 * World-space camera direction for a model-relative camera angle.
 * `model_quat` is the model's world quaternion `[x, y, z, w]`
 * (pass an empty slice for identity).
 */
export function world_direction_for_camera_angle(model_quat: Float32Array, camera_angle: number): Float32Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly embody_request: (a: number, b: number) => [number, number, number, number];
    readonly validate_generated_template_fit_metadata: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
    readonly marker_endpoint_stride: () => number;
    readonly passes_marker_camera_angle_gate: (a: number, b: number, c: number) => number;
    readonly should_show_marker: (a: number, b: number, c: number, d: number) => number;
    readonly resolve_viewport_constrained_line_scale: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
    readonly resolve_viewport_safe_bounds: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
    readonly sample_marker_bezier_curve: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly sample_marker_arc_curve: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly marker_visibility_animation_factors: (a: number, b: number) => [number, number];
    readonly separate_overlapping_marker_endpoints: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
    readonly mesh_proportions_stride: () => number;
    readonly template_skeleton_fit_solution_stride: () => number;
    readonly analyze_mesh_proportions: (a: number, b: number, c: number) => [number, number];
    readonly solve_template_skeleton_fit: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly compose_template_fit_adjustment: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly list_humanoid_skeleton_templates_json: () => [number, number, number, number];
    readonly get_humanoid_skeleton_template_json: (a: number, b: number) => [number, number, number, number];
    readonly humanoid_skeleton_template_bone_names: (a: number, b: number) => [number, number, number, number];
    readonly create_validation_skeleton_json: (a: number, b: number) => [number, number, number, number];
    readonly compute_humanoid_skeleton_template_rest_bounds: (a: number, b: number) => [number, number, number, number];
    readonly extract_humanoid_skeleton_template_json: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly extract_model_data_json: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly analyze_model_descriptor: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
    readonly marker_visibility_factors_stride: () => number;
    readonly hair_color_presets_json: () => [number, number, number, number];
    readonly default_hair_color_appearance_json: () => [number, number, number, number];
    readonly normalize_hair_color_appearance_json: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly hair_config_stride: () => number;
    readonly hair_state_stride: () => number;
    readonly hair_head_state_stride: () => number;
    readonly hair_morph_output_stride: () => number;
    readonly default_hair_physics_config_values: () => [number, number];
    readonly __wbg_hairphysicssolver_free: (a: number, b: number) => void;
    readonly hairphysicssolver_new: (a: number, b: number) => number;
    readonly hairphysicssolver_update: (a: number, b: number, c: number, d: number) => [number, number];
    readonly hairphysicssolver_set_config: (a: number, b: number, c: number) => void;
    readonly hairphysicssolver_get_config: (a: number) => [number, number];
    readonly hairphysicssolver_get_state: (a: number) => [number, number];
    readonly hairphysicssolver_reset: (a: number) => void;
    readonly solve_bilateral_values: (a: number, b: number) => [number, number];
    readonly solve_morph_batch: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly solve_axis_quaternion: (a: number, b: number, c: number, d: number) => [number, number];
    readonly annotation_camera_framing_stride: () => number;
    readonly world_direction_for_camera_angle: (a: number, b: number, c: number) => [number, number];
    readonly resolve_focus_camera_direction: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly resolve_auto_closeup_angle: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly focus_padding_factor: (a: number, b: number, c: number, d: number) => number;
    readonly solve_focus_framing: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number) => [number, number];
    readonly solve_full_body_framing: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number) => [number, number];
    readonly __wbg_cameraflight_free: (a: number, b: number) => void;
    readonly cameraflight_new: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => number;
    readonly cameraflight_sample: (a: number, b: number) => [number, number];
    readonly cameraflight_duration_ms: (a: number) => number;
    readonly __wbg_cameraorbit_free: (a: number, b: number) => void;
    readonly cameraorbit_new: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly cameraorbit_sample: (a: number, b: number) => [number, number];
    readonly cameraorbit_duration_ms: (a: number) => number;
    readonly normalize_camera_angle_degrees: (a: number) => number;
    readonly camera_flight_sample_stride: () => number;
    readonly __wbg_runtimecore_free: (a: number, b: number) => void;
    readonly runtimecore_new: (a: number) => number;
    readonly runtimecore_configure: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly runtimecore_configure_with_profile: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly runtimecore_configure_with_preset: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
    readonly runtimecore_viseme_slot_index: (a: number, b: number, c: number) => number;
    readonly runtimecore_au_morph_binding_stride: () => number;
    readonly runtimecore_viseme_morph_binding_stride: () => number;
    readonly runtimecore_load_au_morph_bindings: (a: number, b: number, c: number) => void;
    readonly runtimecore_load_viseme_morph_bindings: (a: number, b: number, c: number) => void;
    readonly runtimecore_set_mixed_aus: (a: number, b: number, c: number) => void;
    readonly runtimecore_set_au: (a: number, b: number, c: number, d: number) => void;
    readonly runtimecore_set_au_signed: (a: number, b: number, c: number, d: number) => void;
    readonly runtimecore_set_continuum: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly runtimecore_get_continuum: (a: number, b: number, c: number) => number;
    readonly runtimecore_transition_au: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly runtimecore_transition_viseme: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly runtimecore_update: (a: number, b: number) => number;
    readonly runtimecore_active_transition_count: (a: number) => number;
    readonly runtimecore_clear_transitions: (a: number) => void;
    readonly runtimecore_get_au: (a: number, b: number) => number;
    readonly runtimecore_set_au_mix_weight: (a: number, b: number, c: number) => void;
    readonly runtimecore_set_viseme: (a: number, b: number, c: number) => void;
    readonly runtimecore_set_viseme_jaw_scale: (a: number, b: number, c: number) => void;
    readonly runtimecore_set_viseme_slot_count: (a: number, b: number) => void;
    readonly runtimecore_clear: (a: number) => void;
    readonly runtimecore_set_morph: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
    readonly runtimecore_set_morph_index: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly runtimecore_transition_morph: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => number;
    readonly runtimecore_transition_morph_index: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
    readonly runtimecore_load_animation_clips: (a: number, b: number, c: number) => [number, number];
    readonly runtimecore_register_animation_clip: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly runtimecore_build_clip: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly runtimecore_build_typed_clip: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly runtimecore_play_snippet: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly runtimecore_play_typed_snippet: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly runtimecore_update_clip_params: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly runtimecore_cleanup_snippet: (a: number, b: number, c: number) => number;
    readonly runtimecore_get_animation_clips: (a: number) => [number, number, number, number];
    readonly runtimecore_play_animation: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly runtimecore_crossfade_to: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly runtimecore_stop_animation: (a: number, b: number, c: number) => void;
    readonly runtimecore_stop_all_animations: (a: number) => void;
    readonly runtimecore_pause_animation: (a: number, b: number, c: number) => void;
    readonly runtimecore_resume_animation: (a: number, b: number, c: number) => void;
    readonly runtimecore_pause_all_animations: (a: number) => void;
    readonly runtimecore_resume_all_animations: (a: number) => void;
    readonly runtimecore_set_animation_speed: (a: number, b: number, c: number, d: number) => void;
    readonly runtimecore_set_animation_intensity: (a: number, b: number, c: number, d: number) => void;
    readonly runtimecore_set_animation_loop_mode: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly runtimecore_set_animation_repeat_count: (a: number, b: number, c: number, d: number) => void;
    readonly runtimecore_set_animation_reverse: (a: number, b: number, c: number, d: number) => void;
    readonly runtimecore_set_animation_blend_mode: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly runtimecore_seek_animation: (a: number, b: number, c: number, d: number) => void;
    readonly runtimecore_set_animation_time_scale: (a: number, b: number) => void;
    readonly runtimecore_get_animation_state: (a: number, b: number, c: number) => [number, number, number, number];
    readonly runtimecore_get_playing_animations: (a: number) => [number, number, number, number];
    readonly runtimecore_drain_animation_events: (a: number) => [number, number, number, number];
    readonly runtimecore_load_bone_rest_transforms: (a: number, b: number, c: number) => void;
    readonly runtimecore_load_composite_axes: (a: number, b: number, c: number) => void;
    readonly runtimecore_load_bone_translations: (a: number, b: number, c: number) => void;
    readonly runtimecore_load_jaw_binding: (a: number, b: number, c: number) => void;
    readonly runtimecore_load_viseme_jaw_amounts: (a: number, b: number, c: number) => void;
    readonly runtimecore_evaluate_morph_frame_delta: (a: number) => [number, number];
    readonly runtimecore_evaluate_active_morph_frame: (a: number) => [number, number];
    readonly runtimecore_evaluate_bone_frame_delta: (a: number) => [number, number];
    readonly runtimecore_evaluate_active_bone_frame: (a: number) => [number, number];
    readonly runtimecore_evaluate_scene_frame: (a: number) => [number, number, number, number];
    readonly runtimecore_remove_animation_clip: (a: number, b: number, c: number) => number;
    readonly core_abi_version: () => number;
    readonly packed_morph_frame_delta_stride: () => number;
    readonly packed_bone_frame_delta_stride: () => number;
    readonly pack_morph_frame_delta: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number];
    readonly compose_template_skeleton_fit_transform: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly template_skeleton_fit_transform_stride: () => number;
    readonly validate_profile_model: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly list_presets: () => [number, number];
    readonly has_preset: (a: number, b: number) => number;
    readonly get_preset_json: (a: number, b: number) => [number, number, number, number];
    readonly merge_embedded_preset: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly merge_preset_profile: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly resolve_profile_view: (a: number, b: number) => [number, number, number, number];
    readonly resolve_embedded_profile_view: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly compile_clip: (a: number, b: number) => [number, number, number, number];
    readonly compile_clip_curves: (a: number, b: number) => [number, number, number, number];
    readonly build_hair_idle_curves: (a: number, b: number, c: number) => [number, number, number, number];
    readonly build_hair_impulse_curves: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly build_hair_gravity_curves: (a: number, b: number) => [number, number, number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __externref_drop_slice: (a: number, b: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
