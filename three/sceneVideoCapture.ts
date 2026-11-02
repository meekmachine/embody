import type { CharacterSceneRenderingController, CharacterSceneRenderingSnapshot } from './scene';

export type CharacterSceneVideoCaptureOptions = { fps?: number };
export type CharacterSceneVideoCapture = { readonly stream: MediaStream; release(): void };
const activeCaptures = new WeakMap<CharacterSceneRenderingController, Set<() => void>>();

/** Internal scene-owner hook: long-lived video must not block model/scenery retirement. */
export function endCharacterSceneVideoCaptures(rendering: CharacterSceneRenderingController): void {
  for (const end of [...(activeCaptures.get(rendering) ?? [])]) end();
}

/** Borrows the managed renderer without drawing, resizing, or replacing its loop. */
export function acquireCharacterSceneVideoCapture(
  rendering: CharacterSceneRenderingController,
  options: CharacterSceneVideoCaptureOptions = {},
): CharacterSceneVideoCapture {
  const fps = options.fps ?? 30;
  if (!Number.isFinite(fps) || fps < 1 || fps > 60) throw new Error('Video capture frame rate must be between 1 and 60 fps.');
  if (typeof MutationObserver === 'undefined') throw new Error('Canvas size observation is unavailable for video capture.');
  const lease = rendering.acquireRenderer();
  const canvas = lease.renderer.domElement;
  let tracks: MediaStreamTrack[] = [];
  let unsubscribe: (() => void) | null = null;
  let observer: MutationObserver | null = null;
  let released = false;
  let leaseReleased = false;
  const trackListeners: Array<() => void> = [];
  const stoppedTracks = new Set<MediaStreamTrack>();
  const captures = activeCaptures.get(rendering) ?? new Set<() => void>();
  activeCaptures.set(rendering, captures);
  const terminate = () => finish(true);
  captures.add(terminate);

  function cleanup() {
    captures.delete(terminate);
    if (!captures.size && activeCaptures.get(rendering) === captures) activeCaptures.delete(rendering);
    const observing = observer; observer = null;
    try { observing?.disconnect(); } catch { /* Still release tracks and the renderer. */ }
    const subscribed = unsubscribe; unsubscribe = null;
    try { subscribed?.(); } catch { /* A failed observer cannot retain the renderer. */ }
    for (const remove of trackListeners.splice(0)) {
      try { remove(); } catch { /* Continue cleaning up the other tracks. */ }
    }
    for (const track of tracks) {
      if (stoppedTracks.has(track)) continue;
      stoppedTracks.add(track);
      try { track.stop(); } catch { /* Still release the renderer lease. */ }
    }
    if (!leaseReleased) { leaseReleased = true; lease.release(); }
  }

  function finish(notify: boolean) {
    if (released) { cleanup(); return; }
    released = true;
    const ended = notify ? tracks.filter(track => track.readyState !== 'ended') : [];
    // Release synchronously before observers can request a switch/disposal that drains leases.
    cleanup();
    for (const track of ended) {
      try { track.dispatchEvent(new Event('ended')); } catch { /* Other track observers must still be notified. */ }
    }
  }

  function check(snapshot: CharacterSceneRenderingSnapshot) {
    if (snapshot.renderer !== lease.renderer || !['ready', 'error'].includes(snapshot.status)) finish(true);
  }

  try {
    if (typeof canvas.captureStream !== 'function') throw new Error('This renderer canvas cannot provide a video stream.');
    const stream = canvas.captureStream(fps);
    tracks = stream.getTracks();
    if (released) throw new Error('Video capture ended during canvas acquisition.');
    if (!stream.getVideoTracks().some(track => track.readyState === 'live')) throw new Error('The renderer canvas did not provide a live video track.');
    for (const track of tracks) {
      const ended = () => finish(true);
      trackListeners.push(() => track.removeEventListener('ended', ended));
      track.addEventListener('ended', ended);
      if (released) throw new Error('Video capture ended during acquisition.');
    }
    const width = canvas.width, height = canvas.height;
    // subscribe() may immediately invalidate the capture before returning its disposer.
    unsubscribe = rendering.subscribe(check);
    if (released) throw new Error('The renderer changed during video capture acquisition.');
    check(rendering.getSnapshot());
    if (released) throw new Error('The renderer is unavailable for video capture.');
    observer = new MutationObserver(() => {
      if (canvas.width !== width || canvas.height !== height) finish(true);
    });
    if (released) throw new Error('Video capture ended during size observer creation.');
    observer.observe(canvas, { attributes: true, attributeFilter: ['width', 'height'] });
    if (canvas.width !== width || canvas.height !== height) finish(true);
    if (released) throw new Error('The renderer canvas changed size during video capture acquisition.');
    return { stream, release: () => finish(false) };
  } catch (error) {
    finish(false);
    throw error;
  }
}
