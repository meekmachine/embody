/**
 * Embody Interfaces
 *
 * Framework-agnostic interfaces for 3D character animation.
 * Implement these interfaces to add support for different 3D engines.
 */

export type {
  EmbodyRuntime,
  ReadyPayload,
  EmbodyConfig,
} from './EmbodyRuntime';

export type { MeshInfo } from '../mappings/types';

export type { Animation, MixerLoopMode } from './Animation';

export type { HairPhysics, HairPhysicsConfig, HairStrand, HairState } from './HairPhysics';

export type {
  Hair,
  HairPhysicsRuntimeConfig,
  HairPhysicsRuntimeConfigUpdate,
  HairPhysicsDirectionConfig,
  HairMorphTargetsConfig,
  HairObjectRef,
  HairObjectState,
} from './Hair';
