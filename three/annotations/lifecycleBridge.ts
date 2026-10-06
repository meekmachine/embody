import { initEmbodyCore, requireInitializedEmbodyCore } from '@lovelace_lol/embody/wasm';

type Lifecycle = InstanceType<ReturnType<typeof requireInitializedEmbodyCore>['AnnotationLifecycle']>;
export type LifecycleEffect = { kind: 'visibility' | 'style' | 'previewStart' | 'previewEnd'; visible?: boolean; style?: '3d' | 'html' };
/** Clock/queue transport only. All deadline and effect decisions belong to Rust. */
export class AnnotationLifecycleBridge {
  readonly ready: Promise<void>;
  private core: Lifecycle | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: { operation: string; options: unknown; time: number }[] = [];
  private initialized = false;
  constructor(private readonly mode: 'preview' | 'visibility', private readonly duration: number, private readonly apply: (effects: LifecycleEffect[]) => void) {
    try { requireInitializedEmbodyCore(); this.initialized = true; } catch { /* Queue native calls until the shared loader is ready. */ }
    this.ready = this.initialized ? Promise.resolve() : initEmbodyCore().then(() => {
      this.initialized = true;
      const pending = this.pending; this.pending = [];
      for (const entry of pending) this.execute(entry.operation, entry.options, entry.time);
    });
    void this.ready.catch(error => { this.pending = []; console.error('Annotation lifecycle initialization failed.', error); });
  }
  dispatch(operation: string, options: unknown = {}): void {
    const time = performance.now();
    if (!this.initialized) { this.pending.push({ operation, options, time }); return; }
    this.execute(operation, options, time);
  }
  private execute(operation: string, options: unknown, time: number): void {
    if (this.timer !== null) clearTimeout(this.timer); this.timer = null;
    // dispose is reusable host cleanup (including React effect replay). Release
    // the Wasm allocation and create a fresh runtime on the next native call.
    this.core ??= new (requireInitializedEmbodyCore().AnnotationLifecycle)(this.mode, this.duration);
    this.apply(JSON.parse(this.core.command(operation, JSON.stringify(options), time)) as LifecycleEffect[]);
    if (operation === 'dispose') { this.core.free(); this.core = null; return; }
    const deadline = this.core.deadline();
    if (deadline !== undefined) this.timer = setTimeout(() => this.dispatch('tick'), Math.max(0, deadline - performance.now()));
  }
  isActive(): boolean { return this.core?.is_active() ?? false; }
}
