import { control, WebGLRenderer, PMREMGenerator as FixturePMREM } from './three.mjs';

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
