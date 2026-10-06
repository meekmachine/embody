import * as THREE from 'three';
import { requireInitializedEmbodyCore } from '@lovelace_lol/embody/wasm';
import type { AnnotationSnapshot, MarkerDescriptor, NativeAnnotationRuntime } from './runtime';

interface Objects {
  descriptor: string;
  sphere: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  line: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  label: THREE.Sprite;
  texture: THREE.CanvasTexture;
  arrow: THREE.Mesh<THREE.ConeGeometry, THREE.MeshBasicMaterial> | null;
  element: HTMLDivElement | null;
}

/** Applies Rust frame records to native objects. No annotation state machine. */
export class ThreeAnnotationRenderer {
  private readonly group = new THREE.Group();
  private readonly objects = new Map<number, Objects>();
  private readonly overlay: HTMLDivElement;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly viewProjection = new THREE.Matrix4();
  private style = '';
  private revision = -1;
  private meshes: THREE.Mesh[] = [];
  setMeshes(meshes: THREE.Mesh[]): void { this.meshes = meshes; }

  constructor(
    private readonly runtime: NativeAnnotationRuntime,
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
    private domElement: HTMLElement,
    private readonly onPick: (ids: number[]) => void,
    private readonly onHover: (id: number | null) => void,
  ) {
    this.scene.add(this.group);
    this.overlay = document.createElement('div');
    this.overlay.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;';
    (domElement.parentElement ?? domElement).appendChild(this.overlay);
    domElement.addEventListener('click', this.click);
  }
  setDomElement(element: HTMLElement): void {
    if (element === this.domElement) return;
    this.domElement.removeEventListener('click', this.click);
    this.domElement = element;
    (element.parentElement ?? element).appendChild(this.overlay);
    element.addEventListener('click', this.click);
  }
  sync(snapshot: AnnotationSnapshot): void {
    if (this.revision === snapshot.descriptorRevision && this.style === snapshot.style) return;
    if (this.style !== snapshot.style) this.clear();
    this.style = snapshot.style;
    const ids = new Set(snapshot.descriptors.map(descriptor => descriptor.id));
    for (const id of this.objects.keys()) if (!ids.has(id)) this.remove(id);
    for (const descriptor of snapshot.descriptors) {
      const signature = JSON.stringify(descriptor);
      if (this.objects.get(descriptor.id)?.descriptor === signature) continue;
      this.remove(descriptor.id);
      this.objects.set(descriptor.id, this.create(descriptor, signature));
    }
    this.revision = snapshot.descriptorRevision;
  }
  private create(descriptor: MarkerDescriptor, signature: string): Objects {
    const { style } = descriptor;
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(descriptor.radius, 12, 12), new THREE.MeshBasicMaterial({ color: style.markerColor, transparent: true }));
    const dashed = style.line.style === 'dashed' || style.line.style === 'dotted';
    const material = dashed
      ? new THREE.LineDashedMaterial({ color: style.lineColor, transparent: true, dashSize: style.line.style === 'dotted' ? 0.005 : 0.02, gapSize: 0.01, linewidth: style.line.thickness })
      : new THREE.LineBasicMaterial({ color: style.lineColor, transparent: true, linewidth: style.line.thickness });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(51), 3));
    const line = new THREE.Line(geometry, material);
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) { sphere.geometry.dispose(); sphere.material.dispose(); geometry.dispose(); material.dispose(); throw new Error('Annotation labels require a 2D canvas context.'); }
    const font = `${style.labelFontSize}px Arial, sans-serif`;
    context.font = font;
    canvas.width = Math.ceil(context.measureText(descriptor.label).width) + 24;
    canvas.height = Math.ceil(style.labelFontSize * 1.5) + 12;
    context.font = font; context.textAlign = 'center'; context.textBaseline = 'middle';
    context.fillStyle = style.labelBackground; context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = style.labelColor; context.fillText(descriptor.label, canvas.width / 2, canvas.height / 2);
    const texture = new THREE.CanvasTexture(canvas);
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: true, depthWrite: false, sizeAttenuation: false }));
    const arrow = style.line.arrowHead ? new THREE.Mesh(new THREE.ConeGeometry(descriptor.arrowRadius, descriptor.arrowLength, 8), new THREE.MeshBasicMaterial({ color: style.lineColor, transparent: true })) : null;
    let element: HTMLDivElement | null = null;
    if (this.style === 'html') {
      element = document.createElement('div');
      element.className = 'annotation-html-marker'; element.dataset.annotation = descriptor.name;
      element.textContent = descriptor.htmlText; element.title = descriptor.title; element.setAttribute('aria-label', descriptor.title);
      element.style.cssText = 'position:absolute;pointer-events:auto;transform:translate(-50%,-50%);width:24px;height:24px;border-radius:50%;border:2px solid white;display:none;align-items:center;justify-content:center;cursor:pointer;font: bold 12px Arial,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.3);';
      element.style.color = style.labelColor;
      element.addEventListener('mouseenter', () => this.onHover(descriptor.id));
      element.addEventListener('mouseleave', () => this.onHover(null));
      element.addEventListener('click', event => { event.stopPropagation(); this.onPick([descriptor.id]); });
      this.overlay.appendChild(element);
    }
    for (const object of [sphere, line, label, arrow]) if (object) { object.userData.annotationId = descriptor.id; object.visible = false; this.group.add(object); }
    this.runtime.label_metrics(descriptor.id, canvas.width, canvas.height);
    return { descriptor: signature, sphere, line, label, texture, arrow, element };
  }
  update(now: number): void {
    this.camera.updateMatrixWorld();
    this.viewProjection.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    const rect = this.domElement.getBoundingClientRect();
    const rays = this.runtime.occlusion_queries();
    const hits = new Float32Array(rays.length / 8 * 2);
    for (let offset = 0; offset < rays.length; offset += 8) {
      this.raycaster.set(new THREE.Vector3().fromArray(rays, offset + 1), new THREE.Vector3().fromArray(rays, offset + 4));
      this.raycaster.near = 0; this.raycaster.far = rays[offset + 7];
      const intersection = this.raycaster.intersectObjects(this.meshes, false)[0];
      hits[offset / 4] = rays[offset]; hits[offset / 4 + 1] = intersection?.distance ?? Infinity;
    }
    this.runtime.observe_occlusion(hits);
    const values = this.runtime.marker_frame(now, new Float32Array(this.camera.projectionMatrix.elements), new Float32Array(this.viewProjection.elements), rect.width, rect.height);
    const stride = requireInitializedEmbodyCore().annotation_marker_frame_stride();
    for (let offset = 0; offset < values.length; offset += stride) {
      const objects = this.objects.get(values[offset]);
      if (!objects) continue;
      const visible = values[offset + 1] === 1;
      const nativeVisible = visible && !objects.element;
      objects.sphere.visible = objects.line.visible = objects.label.visible = nativeVisible;
      if (objects.arrow) objects.arrow.visible = nativeVisible;
      objects.sphere.position.fromArray(values, offset + 2);
      objects.sphere.scale.setScalar(values[offset + 8]);
      objects.sphere.material.opacity = values[offset + 11]; objects.sphere.material.color.setHex(values[offset + 13]);
      objects.line.material.opacity = values[offset + 12]; objects.line.material.color.setHex(values[offset + 14]);
      const positions = objects.line.geometry.getAttribute('position') as THREE.BufferAttribute;
      (positions.array as Float32Array).set(values.subarray(offset + 19, offset + 70)); positions.needsUpdate = true;
      objects.line.geometry.computeBoundingSphere();
      if (objects.line.material instanceof THREE.LineDashedMaterial) objects.line.computeLineDistances();
      objects.label.position.fromArray(values, offset + 5); objects.label.scale.set(values[offset + 9], values[offset + 10], 1);
      objects.label.material.opacity = values[offset + 11];
      if (objects.arrow) { objects.arrow.position.fromArray(values, offset + 5); objects.arrow.quaternion.fromArray(values, offset + 15); objects.arrow.material.opacity = values[offset + 12]; objects.arrow.material.color.setHex(values[offset + 14]); }
      if (objects.element) { objects.element.style.display = visible ? 'flex' : 'none'; objects.element.style.transform = `translate(-50%,-50%) scale(${values[offset + 72]})`; objects.element.style.background = `#${Math.round(values[offset + 13]).toString(16).padStart(6, '0')}`; objects.element.style.left = `${values[offset + 70]}px`; objects.element.style.top = `${values[offset + 71]}px`; objects.element.style.opacity = String(values[offset + 11]); }
    }
  }
  private readonly click = (event: MouseEvent): void => {
    const rect = this.domElement.getBoundingClientRect();
    this.pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
    this.raycaster.near = 0; this.raycaster.far = Infinity;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    // Raycaster reports native hits. Rust decides which annotation is selectable.
    this.onPick(this.raycaster.intersectObjects([...this.objects.values()].flatMap(objects => [objects.sphere, objects.label]), false).map(hit => hit.object.userData.annotationId as number));
  };
  private remove(id: number): void {
    const objects = this.objects.get(id); if (!objects) return;
    for (const object of [objects.sphere, objects.line, objects.arrow]) if (object) { this.group.remove(object); object.geometry.dispose(); object.material.dispose(); }
    this.group.remove(objects.label); objects.label.material.dispose(); objects.texture.dispose(); objects.element?.remove(); this.objects.delete(id);
  }
  clear(): void { for (const id of this.objects.keys()) this.remove(id); this.revision = -1; }
  dispose(): void { this.domElement.removeEventListener('click', this.click); this.clear(); this.group.removeFromParent(); this.overlay.remove(); this.meshes = []; }
}
