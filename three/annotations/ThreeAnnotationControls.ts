import * as THREE from 'three';
import type { NativeAnnotationRuntime } from './runtime';

/** Native event capture and pose observation. Rust integrates every gesture. */
export class ThreeAnnotationControls extends THREE.EventDispatcher<{ change: {}; start: {}; end: {} }> {
  readonly target = new THREE.Vector3();
  private disposed = false;
  private previousTouchAction = '';
  private connected = false;
  constructor(public domElement: HTMLElement, private readonly runtime: NativeAnnotationRuntime, private readonly advance: () => void, private readonly captureInput = true) {
    super();
    this.connect(domElement);
  }
  connect(element: HTMLElement): void {
    if (this.disposed || (this.connected && this.domElement === element)) return;
    this.disconnect();
    this.domElement = element;
    if (!this.captureInput) return;
    this.previousTouchAction = element.style.touchAction;
    element.style.touchAction = 'none';
    element.addEventListener('pointerdown', this.down);
    element.addEventListener('pointermove', this.move);
    element.addEventListener('pointerup', this.up);
    element.addEventListener('pointercancel', this.cancel);
    element.addEventListener('lostpointercapture', this.cancel);
    element.addEventListener('wheel', this.wheel, { passive: false });
    element.addEventListener('contextmenu', this.contextMenu);
    this.connected = true;
  }
  disconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    this.domElement.removeEventListener('pointerdown', this.down);
    this.domElement.removeEventListener('pointermove', this.move);
    this.domElement.removeEventListener('pointerup', this.up);
    this.domElement.removeEventListener('pointercancel', this.cancel);
    this.domElement.removeEventListener('lostpointercapture', this.cancel);
    this.domElement.removeEventListener('wheel', this.wheel);
    this.domElement.removeEventListener('contextmenu', this.contextMenu);
    this.domElement.style.touchAction = this.previousTouchAction;
    this.runtime.command('input', '{"kind":"disconnect"}', performance.now());
  }
  get enabled(): boolean { return this.read().enabled; }
  set enabled(enabled: boolean) { this.settings({ enabled }); }
  get enableDamping(): boolean { return this.read().enableDamping; }
  set enableDamping(enableDamping: boolean) { this.settings({ enableDamping }); }
  get dampingFactor(): number { return this.read().dampingFactor; }
  set dampingFactor(dampingFactor: number) { this.settings({ dampingFactor }); }
  get minDistance(): number { return this.read().minDistance; }
  set minDistance(minDistance: number) { this.settings({ minDistance }); }
  get maxDistance(): number { return this.read().maxDistance; }
  set maxDistance(maxDistance: number) { this.settings({ maxDistance }); }
  private read(): { enabled: boolean; enableDamping: boolean; dampingFactor: number; minDistance: number; maxDistance: number } { if (this.disposed) throw new Error('Annotation controls are disposed.'); return JSON.parse(this.runtime.command('controls', '{}', performance.now())); }
  private settings(value: unknown): void { if (!this.disposed) this.runtime.command('settings', JSON.stringify(value), performance.now()); }
  update(): void { if (!this.disposed) this.advance(); }
  notifyChange(): void { this.dispatchEvent({ type: 'change' }); }
  private send(kind: string, event: PointerEvent): void {
    const rect = this.domElement.getBoundingClientRect();
    this.runtime.command('input', JSON.stringify({ kind, id: event.pointerId, button: event.button, x: event.clientX, y: event.clientY, width: rect.width, height: rect.height, modifier: event.ctrlKey || event.metaKey || event.shiftKey }), performance.now());
    this.advance();
  }
  private readonly down = (event: PointerEvent): void => { this.domElement.setPointerCapture?.(event.pointerId); this.send('down', event); this.dispatchEvent({ type: 'start' }); };
  private readonly move = (event: PointerEvent): void => { this.send('move', event); };
  private readonly up = (event: PointerEvent): void => { this.send('up', event); if (this.domElement.hasPointerCapture?.(event.pointerId)) this.domElement.releasePointerCapture(event.pointerId); this.dispatchEvent({ type: 'end' }); };
  private readonly cancel = (event: PointerEvent): void => { this.send('cancel', event); this.dispatchEvent({ type: 'end' }); };
  private readonly wheel = (event: WheelEvent): void => {
    event.preventDefault();
    this.runtime.command('input', JSON.stringify({ kind: 'wheel', deltaY: event.deltaY, deltaMode: event.deltaMode, width: this.domElement.clientWidth, height: this.domElement.clientHeight }), performance.now());
    this.advance();
  };
  private readonly contextMenu = (event: Event): void => { event.preventDefault(); };
  dispose(): void {
    if (this.disposed) return;
    this.disconnect();
    this.disposed = true;
  }
}
