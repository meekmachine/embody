import { Scene as ThreeScene, Texture } from 'three';
export * from 'three';

export const control = {
  reset() {
    this.renderers = [];
    this.pmrems = [];
    this.environments = [];
    this.scenes = [];
    this.failure = Object.create(null);
    this.prepare = undefined;
  },
};
control.reset();

// Scene is real Three behavior with an acquisition log for failure cleanup.
export class Scene extends ThreeScene {
  constructor() {
    super();
    control.scenes.push(this);
  }
}

export class WebGLRenderer {
  constructor() {
    if (control.failure.constructor) throw control.failure.constructor;
    this.domElement = { style: {}, parentElement: null };
    this.shadowMap = {};
    this.sizes = [];
    this.disposeCount = 0;
    this.compileCount = 0;
    if (control.failure.missingCompileAsync) this.compileAsync = undefined;
    control.renderers.push(this);
  }
  setPixelRatio(value) { this.pixelRatio = value; }
  setSize(...args) {
    if (control.failure.size) throw control.failure.size;
    this.sizes.push(args);
  }
  compileAsync(scene, camera) {
    this.compileCount++;
    this.scene = scene;
    this.camera = camera;
    if (control.failure.compile) throw control.failure.compile;
    return control.prepare?.(scene, camera) ?? Promise.resolve(scene);
  }
  dispose() {
    this.disposeCount++;
    if (control.failure.dispose) throw control.failure.dispose;
  }
}

export class PMREMGenerator {
  constructor() {
    if (control.failure.pmremConstructor) throw control.failure.pmremConstructor;
    this.disposeCount = 0;
    control.pmrems.push(this);
  }
  fromScene(room) {
    this.room = room;
    if (control.failure.environment) throw control.failure.environment;
    const target = { texture: new Texture(), disposeCount: 0, dispose() { this.disposeCount++; } };
    control.environments.push(target);
    return target;
  }
  dispose() { this.disposeCount++; }
}
