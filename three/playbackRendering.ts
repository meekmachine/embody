import { Timer } from 'three';
import type { AnimationMixer, Object3D } from 'three';

/** Receives this render step's Timer delta in seconds, after every mixer has sampled. */
type AfterFrame = (renderDeltaSeconds: number) => void;
type Binding = { mixer: AnimationMixer; enabled: boolean; afterFrame: AfterFrame };
const bindings = new WeakMap<Object3D, Set<Binding>>();

/** Register native playback with the existing scene renderer; never starts a loop. */
export function bindPlaybackRendering(model: Object3D, mixer: AnimationMixer, afterFrame: AfterFrame) {
  const binding: Binding = { mixer, enabled: true, afterFrame };
  const entries = bindings.get(model) ?? new Set<Binding>();
  entries.add(binding);
  bindings.set(model, entries);
  return {
    setEnabled(enabled: boolean) { binding.enabled = enabled; },
    dispose() {
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
  const delta = timer.getDelta();
  for (const mixer of mixers) mixer.update(delta);
  // Native finished callbacks run inside mixer iteration. Resource release and
  // observers, including responses to the rendered pose, wait until every
  // mixer has finished sampling this frame. Each runs once per render step.
  for (const binding of active) binding.afterFrame(delta);
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
