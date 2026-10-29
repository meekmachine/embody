import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requireInitializedEmbodyCore } from '@lovelace_lol/embody/wasm';
import { ThreeAnnotationRenderer } from '../ThreeAnnotationRenderer';

class InlineStyle {
  cssText = '';
  left = ''; top = ''; width = ''; height = '';
  private value = '';
  private priority = '';
  get position() { return this.value; }
  set position(value: string) { this.value = value; this.priority = ''; }
  getPropertyPriority() { return this.priority; }
  setProperty(_name: string, value: string, priority = '') { this.value = value; this.priority = priority; }
}

const nativeDocument: {
  createElement: () => LayoutElement;
  defaultView: { getComputedStyle: (element: LayoutElement) => { position: string } };
} = {
  createElement: () => new LayoutElement(),
  defaultView: { getComputedStyle: (element: LayoutElement) => ({ position: element.style.position || 'static' }) },
};
class LayoutElement extends EventTarget {
  readonly ownerDocument = nativeDocument;
  readonly style = new InlineStyle();
  parentElement: LayoutElement | null = null;
  children: LayoutElement[] = [];
  clientLeft = 0; clientTop = 0; scrollLeft = 0; scrollTop = 0;
  rect = { left: 0, top: 0, width: 800, height: 600 };
  appendChild(child: LayoutElement) { child.remove(); this.children.push(child); child.parentElement = this; return child; }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
    this.parentElement = null;
  }
  get offsetParent(): LayoutElement | null {
    for (let parent = this.parentElement; parent; parent = parent.parentElement) {
      if (parent.style.position && parent.style.position !== 'static') return parent;
    }
    return null;
  }
  getBoundingClientRect() { return this.rect; }
}
class LayoutObserver {
  static instances: LayoutObserver[] = [];
  readonly observe = vi.fn();
  readonly disconnect = vi.fn();
  constructor(readonly callback: () => void) { LayoutObserver.instances.push(this); }
}
const resources: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('document', nativeDocument);
  vi.stubGlobal('ResizeObserver', LayoutObserver);
});
afterEach(() => {
  resources.splice(0).reverse().forEach(release => release());
  LayoutObserver.instances = [];
  vi.unstubAllGlobals();
});

function fixture(parent = new LayoutElement()) {
  const canvas = new LayoutElement(); parent.appendChild(canvas);
  const runtime = new (requireInitializedEmbodyCore().AnnotationRuntime)('{}');
  const renderer = new ThreeAnnotationRenderer(runtime, new THREE.Scene(), new THREE.PerspectiveCamera(), canvas as unknown as HTMLElement, () => {}, () => {});
  resources.push(() => { renderer.dispose(); runtime.dispose(); runtime.free(); });
  return { parent, canvas, renderer, overlay: parent.children.at(-1)!, observer: LayoutObserver.instances.at(-1)! };
}

describe('annotation overlay native layout', () => {
  it('aligns an offset canvas inside a bordered, scrolled parent and follows layout and resize changes', () => {
    const parent = new LayoutElement();
    parent.rect = { left: 100, top: 200, width: 1000, height: 800 };
    parent.clientLeft = 4; parent.clientTop = 6;
    parent.scrollLeft = 20; parent.scrollTop = 30;
    const { canvas, renderer, overlay, observer } = fixture(parent);
    canvas.rect = { left: 150, top: 260, width: 640, height: 480 };
    renderer.update(0);
    expect(parent.style.position).toBe('relative');
    expect(overlay.style).toMatchObject({ left: '66px', top: '84px', width: '640px', height: '480px' });
    canvas.rect = { left: 180, top: 300, width: 400, height: 250 };
    observer.callback();
    expect(overlay.style).toMatchObject({ left: '96px', top: '124px', width: '400px', height: '250px' });
    expect(observer.observe).toHaveBeenCalledWith(canvas);
    expect(observer.observe).toHaveBeenCalledWith(parent);
    parent.scrollTop = 40;
    renderer.update(16);
    expect(overlay.style.top).toBe('134px');
  });

  it('releases the old parent on canvas rebind and restores each parent after its final borrower', () => {
    const first = fixture();
    const parent = new LayoutElement(); parent.style.position = 'static';
    parent.rect = { left: 200, top: 100, width: 800, height: 600 };
    const canvas = new LayoutElement(); canvas.rect = { left: 220, top: 130, width: 300, height: 200 };
    parent.appendChild(canvas);
    first.renderer.setDomElement(canvas as unknown as HTMLElement);
    expect(first.parent.style.position).toBe('');
    expect(first.parent.children).toEqual([first.canvas]);
    expect(first.overlay.parentElement).toBe(parent);
    expect(first.overlay.style).toMatchObject({ left: '20px', top: '30px', width: '300px', height: '200px' });
    expect(parent.style.position).toBe('relative');
    first.renderer.dispose();
    expect(parent.style.position).toBe('static');
    expect(parent.children).toEqual([canvas]);
    expect(first.observer.disconnect).toHaveBeenCalled();
  });

  it('retains a shared containing block until both overlays release and restores inline priority', () => {
    const parent = new LayoutElement(); parent.style.setProperty('position', 'static', 'important');
    const first = fixture(parent);
    const second = fixture(parent);
    first.renderer.dispose();
    expect(parent.style.position).toBe('relative');
    expect(second.overlay.parentElement).toBe(parent);
    second.renderer.dispose();
    expect(parent.style.position).toBe('static');
    expect(parent.style.getPropertyPriority()).toBe('important');
  });

  it('preserves host edits while multiple overlays are attached', () => {
    const parent = new LayoutElement();
    const first = fixture(parent); const second = fixture(parent);
    parent.style.setProperty('position', 'absolute', 'important');
    first.renderer.dispose(); second.renderer.dispose();
    expect(parent.style.position).toBe('absolute');
    expect(parent.style.getPropertyPriority()).toBe('important');
  });

  it('uses the actual containing block after the host changes its borrowed parent to static', () => {
    const ancestor = new LayoutElement(); ancestor.style.position = 'relative';
    ancestor.rect = { left: 20, top: 30, width: 1000, height: 800 };
    const parent = new LayoutElement(); ancestor.appendChild(parent);
    const { canvas, renderer, overlay } = fixture(parent);
    canvas.rect = { left: 150, top: 260, width: 640, height: 480 };
    parent.style.position = 'static';
    renderer.update(0);
    expect(overlay.style).toMatchObject({ left: '130px', top: '230px' });
    renderer.dispose();
    expect(parent.style.position).toBe('static');
    expect(ancestor.style.position).toBe('relative');
  });
});
