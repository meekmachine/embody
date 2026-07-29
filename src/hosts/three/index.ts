/**
 * Three.js host adapter package.
 * Re-exports inspector/applier from engines/three for a single host entry.
 */
export { buildFrameApplierBindings } from './frameBindings';
export { RustEmbodyHost, createRustEmbodyHost } from './RustEmbodyHost';
export type { RustEmbodyHostConfig } from './RustEmbodyHost';

export { ThreeModelInspector } from '../../engines/three/ThreeModelInspector';
export type {
  ThreeModelInspection,
  ThreeModelInspectionOptions,
} from '../../engines/three/ThreeModelInspector';
export { THREE_BLENDING_MODES, ThreeFrameApplier } from '../../engines/three/ThreeFrameApplier';
export type { ThreeFrameApplierBindings } from '../../engines/three/ThreeFrameApplier';
export { ThreeAnimationSystem } from '../../engines/three/ThreeAnimationRuntime';
