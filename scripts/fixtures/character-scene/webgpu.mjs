import { control, WebGLRenderer, PMREMGenerator as FixturePMREM } from './three.mjs';
import { WebGPUCoordinateSystem } from 'three';

function backend(native) {
  return { isWebGPUBackend: native, disposeCount: 0, dispose() { this.disposeCount++; } };
}

export class WebGPURenderer extends WebGLRenderer {
  constructor() {
    super();
    this.initialBackend = this.backend = backend(true);
    this.initialized = false;
    this.initCount = 0;
    this.loopCallbacks = [];
    this.internalDeviceLosses = [];
    this.onDeviceLost = (info) => { this.internalDeviceLosses.push(info); };
    control.gpuRenderers.push(this);
  }
  async init() {
    this.initCount++;
    await control.initialize?.(this);
    if (control.failure.fallback) this.backend = backend(false);
    if (control.failure.init) throw control.failure.init;
    this.initialized = true;
    return this;
  }
  hasInitialized() { return this.initialized; }
  render(scene, camera) {
    // Match r184's persistent camera mutation at the renderer boundary.
    for (const current of [camera, ...scene.children.filter(child => child.shadow).map(light => light.shadow.camera)]) {
      current.coordinateSystem = WebGPUCoordinateSystem;
      current.updateProjectionMatrix();
    }
    super.render(scene, camera);
  }
  async setAnimationLoop(callback) { this.loopCallbacks.push(callback); }
  dispose() {
    // Three's real pre-init dispose would re-enter init through setAnimationLoop.
    if (!this.initialized) throw new Error('unsafe pre-init renderer.dispose');
    super.dispose();
    this.backend.dispose();
  }
}

export class PMREMGenerator extends FixturePMREM {
  constructor(renderer) {
    if (!renderer.hasInitialized()) throw new Error('PMREM requires initialized renderer');
    super();
    this.backend = 'webgpu';
  }
}
