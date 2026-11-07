import type { Camera, Object3D } from 'three';
import type { GazeGeometryInput } from '@lovelace_lol/embody/wasm';
import { reportSceneObserverError, subscribeSceneObservations } from './sceneObservations';

export type GazeGeometryFacts = Omit<GazeGeometryInput, 'target' | 'targetRollDegrees'> & {
  characterWorldPosition: [number, number, number];
  characterWorldScale: [number, number, number];
  bindingRevision: number;
};
export type GazeGeometryObservation =
  | { available: true; generation: number; sequence: number; facts: GazeGeometryFacts }
  | { available: false; generation: number; sequence: number; reason: string };
export type GazeGeometryReader = { getGazeGeometryFacts(camera: Camera): GazeGeometryFacts; getGazeBindingRevision?(): number };

/** One passive observer per CharacterHost. Geometry belongs to Embody, not a UI sampler. */
export function createGazeGeometryObservationSource(scene: Object3D, current: () => { engine: GazeGeometryReader; camera: Camera } | null) {
  const listeners = new Set<(event: GazeGeometryObservation) => void>();
  let unregister: (() => void) | undefined;
  let last: GazeGeometryObservation | undefined;
  let engine: GazeGeometryReader | undefined;
  let revision: number | undefined;
  let generation = 0, sequence = 0, sampledAt = -Infinity;
  let disposed = false;
  const emit = (event: GazeGeometryObservation) => {
    last = event;
    for (const listener of [...listeners]) {
      if (last !== event) break;
      if (!listeners.has(listener)) continue;
      try { listener(event); } catch (error) { reportSceneObserverError(error); }
    }
  };
  const unavailable = (reason: string) => {
    if (last?.available === false && last.generation === generation && last.reason === reason) return;
    emit({ available: false, generation, sequence: ++sequence, reason });
  };
  const sameFacts = (left: GazeGeometryFacts, right: GazeGeometryFacts) => {
    const a = [...left.cameraPosition, ...left.cameraQuaternion, ...left.characterWorldQuaternion, ...left.eyeOriginWorld,
      ...left.characterWorldPosition, ...left.characterWorldScale, left.verticalFovDegrees, left.aspect, left.bindingRevision];
    const b = [...right.cameraPosition, ...right.cameraQuaternion, ...right.characterWorldQuaternion, ...right.eyeOriginWorld,
      ...right.characterWorldPosition, ...right.characterWorldScale, right.verticalFovDegrees, right.aspect, right.bindingRevision];
    return a.every((value, index) => Math.abs(value - b[index]) <= 1e-7 * Math.max(1, Math.abs(value), Math.abs(b[index])));
  };
  const sample = (force = false) => {
    if (disposed || !listeners.size) return;
    const now = performance.now();
    if (!force && now - sampledAt < 1000 / 30) return;
    sampledAt = now;
    const active = current();
    if (!active) { unavailable('character-unavailable'); return; }
    try {
      const facts = active.engine.getGazeGeometryFacts(active.camera);
      if (engine !== active.engine || revision !== facts.bindingRevision) {
        generation += 1;
        const capturedGeneration = generation;
        if (engine) unavailable('binding-replaced');
        const currentRevision = active.engine.getGazeBindingRevision?.();
        if (disposed || generation !== capturedGeneration || current()?.engine !== active.engine
          || currentRevision !== undefined && currentRevision !== facts.bindingRevision) return;
        engine = active.engine; revision = facts.bindingRevision;
      }
      if (last?.available && last.generation === generation && sameFacts(last.facts, facts)) return;
      emit({ available: true, generation, sequence: ++sequence, facts });
    } catch (error) {
      unavailable(error instanceof Error ? error.message : 'geometry-unavailable');
    }
  };
  return {
    subscribe(listener: (event: GazeGeometryObservation) => void): () => void {
      if (disposed) {
        try { listener({ available: false, generation, sequence, reason: 'disposed' }); } catch (error) { reportSceneObserverError(error); }
        return () => {};
      }
      listeners.add(listener);
      if (!unregister) unregister = subscribeSceneObservations(scene, () => sample());
      const previous = last;
      sample(true);
      if (last === previous && last && listeners.has(listener)) {
        try { listener(last); } catch (error) { reportSceneObserverError(error); }
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size) { unregister?.(); unregister = undefined; }
      };
    },
    invalidate(reason: string) {
      generation += 1; engine = undefined; revision = undefined;
      unavailable(reason); sampledAt = -Infinity;
    },
    dispose() {
      if (disposed) return;
      disposed = true; generation += 1;
      unavailable('disposed'); listeners.clear(); unregister?.(); unregister = undefined;
    },
  };
}
