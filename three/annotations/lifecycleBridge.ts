import { initEmbodyCore, requireInitializedEmbodyCore } from '@lovelace_lol/embody/wasm';

type Lifecycle = InstanceType<ReturnType<typeof requireInitializedEmbodyCore>['AnnotationLifecycle']>;
export type LifecycleEffect = { kind: 'visibility' | 'style' | 'previewStart' | 'previewEnd'; visible?: boolean; style?: '3d' | 'html' };
/** Clock/queue transport only. All deadline and effect decisions belong to Rust. */
export class AnnotationLifecycleBridge {
  private readiness: Promise<void> = Promise.resolve();
  private initializing: Promise<void> | null = null;
  private core: Lifecycle | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: { operation: string; options: unknown; time: number }[] = [];
  private initialized = false;
  private commandRevision = 0;
  constructor(private readonly mode: 'preview' | 'visibility', private readonly duration: number, private readonly apply: (effects: LifecycleEffect[]) => void) {
    this.initialize();
  }
  /** The current attempt; dispatching after a failed attempt can start a retry. */
  get ready(): Promise<void> { return this.readiness; }
  private initialize(): void {
    if (this.initialized) return;
    // Another scene may have retried the shared loader after our earlier failure.
    try { requireInitializedEmbodyCore(); this.initialized = true; }
    catch { /* Queue native calls until the shared loader is ready. */ }
    if (this.initialized) {
      this.readiness = Promise.resolve();
      this.drainPending();
      return;
    }
    if (this.initializing) return;
    this.initializing = initEmbodyCore().then(() => {
      this.initializing = null;
      this.initialized = true;
      this.drainPending();
    }, error => {
      this.initializing = null;
      this.pending = [];
      throw error;
    });
    this.readiness = this.initializing;
    void this.readiness.catch(error => { console.error('Annotation lifecycle initialization failed.', error); });
  }
  private drainPending(): void {
    // Consume the live queue so cleanup from a callback can cancel its tail.
    while (this.pending.length) {
      const entry = this.pending.shift()!;
      this.execute(entry.operation, entry.options, entry.time);
    }
  }
  dispatch(operation: string, options: unknown = {}): void {
    const time = performance.now();
    if (operation === 'dispose') {
      this.pending = [];
      if (!this.initialized) return;
    }
    if (!this.initialized) { this.pending.push({ operation, options, time }); this.initialize(); return; }
    this.execute(operation, options, time);
  }
  private execute(operation: string, options: unknown, time: number): void {
    const revision = ++this.commandRevision;
    if (this.timer !== null) clearTimeout(this.timer); this.timer = null;
    // dispose is reusable host cleanup (including React effect replay). Release
    // the Wasm allocation and create a fresh runtime on the next native call.
    const core = this.core ??= new (requireInitializedEmbodyCore().AnnotationLifecycle)(this.mode, this.duration);
    const effects = JSON.parse(core.command(operation, JSON.stringify(options), time)) as LifecycleEffect[];
    if (operation === 'dispose') { this.core = null; core.free(); }
    this.apply(effects);
    // A callback can dispose/reuse the lifecycle; its newer command owns timers.
    if (operation === 'dispose' || revision !== this.commandRevision) return;
    const deadline = core.deadline();
    if (deadline !== undefined) this.timer = setTimeout(() => this.dispatch('tick'), Math.max(0, deadline - performance.now()));
  }
  isActive(): boolean { return this.core?.is_active() ?? false; }
}
