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

export interface EmbodyCoreWasmModule {
  default?: (moduleOrPath?: unknown) => Promise<unknown> | unknown;
  core_abi_version(): number;
  packed_morph_frame_delta_stride(): number;
  pack_morph_frame_delta(
    meshIds: Uint32Array,
    morphTargetIds: Uint32Array,
    values: Float32Array,
    modes: Uint8Array
  ): Float32Array;
  solve_bilateral_values(base: number, balance: number): Float32Array;
  solve_morph_batch(values: Float32Array, balances: Float32Array, mixWeights: Float32Array): Float32Array;
  solve_axis_quaternion(axis: number, degrees: number, value: number, scale: number): Float32Array;
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
}
