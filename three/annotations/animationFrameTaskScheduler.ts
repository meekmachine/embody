export type AnimationFrameTask = (now: number) => boolean;

/**
 * Runs multiple short UI animation tasks from one requestAnimationFrame loop.
 *
 * Tasks return true while they need another frame and false when complete.
 */
export class AnimationFrameTaskScheduler {
  private frameId: number | null = null;
  private readonly tasks = new Map<string, AnimationFrameTask>();

  get size(): number {
    return this.tasks.size;
  }

  has(key: string): boolean {
    return this.tasks.has(key);
  }

  schedule(key: string, task: AnimationFrameTask, runImmediately = true): void {
    this.cancel(key);

    if (runImmediately && !task(performance.now())) {
      return;
    }

    this.tasks.set(key, task);
    this.requestFrame();
  }

  cancel(key: string): void {
    this.tasks.delete(key);
    this.cancelFrameIfIdle();
  }

  cancelAll(): void {
    this.tasks.clear();
    this.cancelFrameIfIdle();
  }

  private requestFrame(): void {
    if (this.frameId !== null || this.tasks.size === 0) {
      return;
    }

    this.frameId = requestAnimationFrame(this.tick);
  }

  private readonly tick = (now: number): void => {
    this.frameId = null;

    for (const [key, task] of Array.from(this.tasks)) {
      if (!this.tasks.has(key) || !task(now)) {
        this.tasks.delete(key);
      }
    }

    this.requestFrame();
  };

  private cancelFrameIfIdle(): void {
    if (this.tasks.size > 0 || this.frameId === null) {
      return;
    }

    cancelAnimationFrame(this.frameId);
    this.frameId = null;
  }
}
