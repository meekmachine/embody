/**
 * Embody - Physics Exports
 */

export {
  HairPhysics,
  DEFAULT_HAIR_PHYSICS_CONFIG,
} from './HairPhysics';
export {
  RustHairPhysics,
  createRustHairPhysics,
  packHairConfig,
  packHeadState,
  unpackHairConfig,
  unpackHairMorphOutput,
  unpackHairState,
} from './RustHairPhysics';

export type {
  HairPhysicsConfig,
  HairPhysicsState,
  HairMorphOutput,
  HeadState,
} from './HairPhysics';
