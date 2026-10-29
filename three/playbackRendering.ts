import { Timer } from 'three';
import type { AnimationMixer, Object3D } from 'three';

type Binding = { mixer: AnimationMixer; enabled: boolean; disposed: boolean; afterFrame: (deltaSeconds: number) => void; afterSample?: (deltaSeconds: number) => void };
const bindings = new WeakMap<Object3D, Set<Binding>>();

/** Register native playback with the existing scene renderer; never starts a loop. */
export function bindPlaybackRendering(model: Object3D, mixer: AnimationMixer, afterFrame: (deltaSeconds: number) => void, afterSample?: (deltaSeconds: number) => void) {
  const binding: Binding = { mixer, enabled: true, disposed: false, afterFrame, afterSample };
  const entries = bindings.get(model) ?? new Set<Binding>();
  entries.add(binding);
  bindings.set(model, entries);
  return {
    setEnabled(enabled: boolean) { binding.enabled = enabled; },
    dispose() {
      binding.disposed = true;
      entries.delete(binding);
      if (!entries.size) bindings.delete(model);
    },
  };
}

/** Called once by the Three render integration, using its native Timer. */
export function renderScenePlayback(scene: Object3D, timer: Timer): void {
  const mixers = new Set<AnimationMixer>();
  const active: Binding[] = [];
  scene.traverse((object) => {
    for (const binding of bindings.get(object) ?? []) {
      if (binding.enabled) { active.push(binding); mixers.add(binding.mixer); }
    }
  });
  const deltaSeconds = timer.getDelta();
  const elapsed = new Map<AnimationMixer, number>();
  for (const mixer of mixers) {
    // Physics advances forward even when a native animation plays backward;
    // its actual reversed pose determines the direction of the hair response.
    elapsed.set(mixer, Math.abs(deltaSeconds * mixer.timeScale));
    mixer.update(deltaSeconds);
  }
  // Observe the actual blended pose only after all native sampling. Response
  // samples are staged for the next native frame, without a second mixer pass.
  for (const binding of active) if (binding.enabled && !binding.disposed) {
    binding.afterSample?.(elapsed.get(binding.mixer)!);
  }
  // Native finished callbacks run inside mixer iteration. Resource release and
  // observers must wait until every mixer has finished sampling this frame.
  for (const binding of active) if (binding.enabled && !binding.disposed) binding.afterFrame(deltaSeconds);
}

/** Frame hook for an existing Three/R3F renderer. Does not create a render loop. */
export function createScenePlaybackFrame(scene: Object3D, document?: Document) {
  const timer = new Timer();
  if (document) timer.connect(document);
  let disposed = false;
  let initialized = false;
  return {
    onFrame(timestamp?: number) {
      if (disposed) return;
      timer.update(timestamp);
      // The first render establishes this renderer's timestamp origin.
      if (!initialized) { initialized = true; return; }
      renderScenePlayback(scene, timer);
    },
    dispose() { if (!disposed) { disposed = true; timer.dispose(); } },
  };
}
