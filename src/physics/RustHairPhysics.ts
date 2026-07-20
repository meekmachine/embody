import type { HairMorphOutput, HairPhysicsConfig, HairPhysicsState, HeadState } from './HairPhysics';
import {
  DEFAULT_HAIR_PHYSICS_CONFIG,
} from './HairPhysics';
import {
  HAIR_CONFIG_STRIDE,
  HAIR_HEAD_STATE_STRIDE,
  HAIR_MORPH_OUTPUT_FIELDS,
  HAIR_MORPH_OUTPUT_STRIDE,
  HAIR_STATE_STRIDE,
  initEmbodyCore,
} from '../wasm';
import type { WasmHairPhysicsSolver } from '../wasmTypes';

export class RustHairPhysics {
  private solver: WasmHairPhysicsSolver;

  private constructor(solver: WasmHairPhysicsSolver) {
    this.solver = solver;
  }

  static async create(config: Partial<HairPhysicsConfig> = {}): Promise<RustHairPhysics> {
    const core = await initEmbodyCore();
    return new RustHairPhysics(new core.HairPhysicsSolver(packHairConfig(config)));
  }

  update(dt: number, headState: HeadState): HairMorphOutput {
    return unpackHairMorphOutput(this.solver.update(dt, packHeadState(headState)));
  }

  getState(): HairPhysicsState {
    return unpackHairState(this.solver.get_state());
  }

  setConfig(config: Partial<HairPhysicsConfig>): void {
    this.solver.set_config(packHairConfig({ ...this.getConfig(), ...config }));
  }

  getConfig(): HairPhysicsConfig {
    return unpackHairConfig(this.solver.get_config());
  }

  reset(): void {
    this.solver.reset();
  }

  dispose(): void {
    this.solver.free?.();
  }
}

export async function createRustHairPhysics(config: Partial<HairPhysicsConfig> = {}): Promise<RustHairPhysics> {
  return RustHairPhysics.create(config);
}

export function packHairConfig(config: Partial<HairPhysicsConfig> = {}): Float32Array {
  const merged = { ...DEFAULT_HAIR_PHYSICS_CONFIG, ...config };
  const values = new Float32Array(HAIR_CONFIG_STRIDE);
  values[0] = merged.mass;
  values[1] = merged.stiffness;
  values[2] = merged.damping;
  values[3] = merged.gravity;
  values[4] = merged.headInfluence;
  values[5] = merged.windEnabled ? 1 : 0;
  values[6] = merged.windStrength;
  values[7] = merged.windDirectionX;
  values[8] = merged.windDirectionZ;
  values[9] = merged.windTurbulence;
  values[10] = merged.windFrequency;
  return values;
}

export function packHeadState(headState: HeadState): Float32Array {
  const values = new Float32Array(HAIR_HEAD_STATE_STRIDE);
  values[0] = headState.yaw;
  values[1] = headState.pitch;
  values[2] = headState.roll;
  values[3] = headState.yawVelocity;
  values[4] = headState.pitchVelocity;
  return values;
}

export function unpackHairConfig(values: ArrayLike<number>): HairPhysicsConfig {
  assertStride(values, HAIR_CONFIG_STRIDE, 'hair config');
  return {
    mass: values[0],
    stiffness: values[1],
    damping: values[2],
    gravity: values[3],
    headInfluence: values[4],
    windEnabled: values[5] >= 0.5,
    windStrength: values[6],
    windDirectionX: values[7],
    windDirectionZ: values[8],
    windTurbulence: values[9],
    windFrequency: values[10],
  };
}

export function unpackHairState(values: ArrayLike<number>): HairPhysicsState {
  assertStride(values, HAIR_STATE_STRIDE, 'hair state');
  return {
    x: values[0],
    z: values[1],
    vx: values[2],
    vz: values[3],
  };
}

export function unpackHairMorphOutput(values: ArrayLike<number>): HairMorphOutput {
  assertStride(values, HAIR_MORPH_OUTPUT_STRIDE, 'hair morph output');
  return HAIR_MORPH_OUTPUT_FIELDS.reduce((output, key, index) => {
    output[key] = values[index];
    return output;
  }, {} as HairMorphOutput);
}

function assertStride(values: ArrayLike<number>, expected: number, label: string): void {
  if (values.length < expected) {
    throw new Error(`Invalid ${label} buffer length ${values.length}; expected at least ${expected}.`);
  }
}
