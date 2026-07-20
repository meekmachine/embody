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
  HairPhysicsSolver: WasmHairPhysicsSolverConstructor;
  RuntimeCore: WasmRuntimeCoreConstructor;
}
