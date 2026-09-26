import {
  createRustAnnotationCameraCore,
  type RustAnnotationCameraCore,
} from './adapter';

let core: RustAnnotationCameraCore | null = null;
let initialization: Promise<RustAnnotationCameraCore> | null = null;

/** Share the stateless Rust math adapter across cameras and markers. */
export function getAnnotationCameraCore(): Promise<RustAnnotationCameraCore> {
  initialization ??= createRustAnnotationCameraCore().then(
    (initialized) => {
      core = initialized;
      return initialized;
    },
    (error: unknown) => {
      initialization = null;
      throw error;
    },
  );
  return initialization;
}

/** Synchronous render-loop math is available after the owning load awaits initialization. */
export function requireAnnotationCameraCore(): RustAnnotationCameraCore {
  if (!core) {
    throw new Error('Annotation camera core is not ready. Await getAnnotationCameraCore() before using annotation math.');
  }
  return core;
}
