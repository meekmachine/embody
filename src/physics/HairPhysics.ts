/**
 * Host-neutral hair physics types and defaults.
 *
 * Simulation lives in the Rust Wasm `HairPhysicsSolver`. This module only
 * carries the JSON/typed-array packing shapes used at the host boundary.
 */

export interface HairPhysicsConfig {
  mass: number;
  stiffness: number;
  damping: number;
  gravity: number;
  headInfluence: number;
  windEnabled: boolean;
  windStrength: number;
  windDirectionX: number;
  windDirectionZ: number;
  windTurbulence: number;
  windFrequency: number;
}

export interface HairPhysicsState {
  x: number;
  z: number;
  vx: number;
  vz: number;
}

export interface HairMorphOutput {
  L_Hair_Left: number;
  L_Hair_Right: number;
  L_Hair_Front: number;
  R_Hair_Left: number;
  R_Hair_Right: number;
  R_Hair_Front: number;
}

export interface HeadState {
  yaw: number;
  pitch: number;
  roll: number;
  yawVelocity: number;
  pitchVelocity: number;
}

export const DEFAULT_HAIR_PHYSICS_CONFIG: HairPhysicsConfig = {
  mass: 1.0,
  stiffness: 15,
  damping: 0.8,
  gravity: 9.8,
  headInfluence: 0.5,
  windEnabled: false,
  windStrength: 0,
  windDirectionX: 1,
  windDirectionZ: 0,
  windTurbulence: 0.2,
  windFrequency: 0.5,
};
