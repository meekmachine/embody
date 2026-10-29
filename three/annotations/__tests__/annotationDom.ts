import { vi } from 'vitest';

/** Native resource fixture; these tests drive the real Wasm runtime without a browser. */
export class AnnotationElement extends EventTarget {
  style: Record<string, string> = { touchAction: '' };
  dataset: Record<string, string> = {};
  children: AnnotationElement[] = [];
  parentElement: AnnotationElement | null = null;
  clientWidth = 800;
  clientHeight = 600;
  width = 0;
  height = 0;
  className = '';
  textContent = '';
  title = '';
  setAttribute() {}
  appendChild(child: AnnotationElement) { child.remove(); child.parentElement = this; this.children.push(child); return child; }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
  getBoundingClientRect() { return { width: this.clientWidth, height: this.clientHeight, left: 0, top: 0 }; }
  getContext() { return { measureText: (text: string) => ({ width: text.length * 16 }), fillRect() {}, fillText() {} }; }
  setPointerCapture() {}
  hasPointerCapture() { return false; }
  releasePointerCapture() {}
}
export function installAnnotationDom() {
  const host = new AnnotationElement();
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  vi.stubGlobal('document', { createElement: () => new AnnotationElement() });
  vi.stubGlobal('window', { innerWidth: 800, innerHeight: 600, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++id, callback); return id; });
  vi.stubGlobal('cancelAnimationFrame', (frame: number) => { frames.delete(frame); });
  return { host, domElement: host as unknown as HTMLElement, frames,
    frame: (now: number) => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(now)); },
  };
}
export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
