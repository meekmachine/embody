export * from './three/index';
export * from './wasm/index';

// Both entry points retain these public types. Select their shared definition
// explicitly so the packed root declarations do not expose ambiguous exports.
export type { ClipIR, ClipIRChannel, ClipIRTarget, ClipIRTrack } from './wasm/clip-ir';
