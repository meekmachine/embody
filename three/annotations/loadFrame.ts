/** Continue in a task after paint, rather than in the animation-frame microtask. */
export function waitForCharacterLoadPaint(): Promise<void> {
  return new Promise((resolve) => {
    let frame: number | undefined;
    let task: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      clearTimeout(fallback);
      if (task !== undefined) clearTimeout(task);
      if (frame !== undefined && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
      resolve();
    };
    // Hidden tabs can suspend rAF, including after the visibility check.
    const fallback = setTimeout(finish, 100);
    if (typeof requestAnimationFrame === 'function' &&
        (typeof document === 'undefined' || document.visibilityState !== 'hidden')) {
      frame = requestAnimationFrame(() => { task = setTimeout(finish, 0); });
    } else {
      task = setTimeout(finish, 0);
    }
  });
}
