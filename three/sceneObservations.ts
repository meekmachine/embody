import type { Object3D } from 'three';

const observers = new WeakMap<Object3D, Set<() => void>>();
export function reportSceneObserverError(error: unknown): void {
  try { globalThis.reportError?.(error); } catch { /* Error reporting cannot own render or cleanup. */ }
}
/** Subscribe to an existing renderer's settled native scene; never creates a loop. */
export function subscribeSceneObservations(scene: Object3D, listener: () => void): () => void {
  const entries = observers.get(scene) ?? new Set<() => void>();
  entries.add(listener); observers.set(scene, entries);
  return () => { entries.delete(listener); if (!entries.size) observers.delete(scene); };
}
/** Renderer adapters call after camera update and native mixer sampling. */
export function publishSceneObservations(scene: Object3D): void {
  const entries = observers.get(scene);
  if (!entries) return;
  for (const listener of [...entries]) {
    if (!entries.has(listener)) continue;
    // A consumer cannot interrupt native rendering or another observer.
    try { listener(); } catch (error) { reportSceneObserverError(error); }
  }
}
