import * as THREE from 'three';
import type { CharacterSceneRenderer } from '../scene';

function captureRenderTarget(renderer: CharacterSceneRenderer): () => void {
  const face = renderer.getActiveCubeFace();
  const mip = renderer.getActiveMipmapLevel();
  if ('isWebGPURenderer' in renderer) {
    const target = renderer.getRenderTarget();
    return () => renderer.setRenderTarget(target, face, mip);
  }
  const target = renderer.getRenderTarget();
  return () => renderer.setRenderTarget(target, face, mip);
}

/** Only the model root is exposed; authored child visibility and layers are retained. */
function withPreparedModel<T>(scene: THREE.Scene, model: THREE.Object3D, operation: () => T): T {
  if (model === scene) throw new Error('Render preparation requires a model, not the controller scene.');
  let ancestor = model;
  while (ancestor.parent) {
    ancestor = ancestor.parent;
    if (!ancestor.visible) throw new Error('Render preparation requires visible model ancestors.');
  }
  if (model.parent && ancestor !== scene) throw new Error('Render preparation requires a detached model or a model in the controller scene.');
  const detached = !model.parent;
  const visible = model.visible;
  const culling = new Map<THREE.Object3D, boolean>();
  try {
    if (detached) scene.add(model);
    model.visible = true;
    model.traverseVisible((object) => {
      culling.set(object, object.frustumCulled);
      object.frustumCulled = false;
    });
    return operation();
  } finally {
    culling.forEach((value, object) => { object.frustumCulled = value; });
    model.visible = visible;
    if (detached) scene.remove(model);
  }
}

/** Three collects visible surfaces before yielding; no shared mutations span the await. */
export function compileModelForRender(
  renderer: CharacterSceneRenderer, scene: THREE.Scene, camera: THREE.Camera, model: THREE.Object3D,
): Promise<unknown> {
  if ('isWebGPURenderer' in renderer && !renderer.hasInitialized()) {
    throw new Error('Model render preparation requires an initialized WebGPU renderer.');
  }
  // Only the caller-owned model is retained across asynchronous compilation.
  // Controller markers may still be replaced/disposed while this is pending.
  return withPreparedModel(scene, model, () => renderer.compileAsync(model, camera, scene));
}

/** One complete scene draw initializes native geometry/textures and real shadow variants. */
export function drawModelForRender(
  renderer: CharacterSceneRenderer, scene: THREE.Scene, camera: THREE.Camera, model: THREE.Object3D,
): () => void {
  const viewport = renderer.getViewport(new THREE.Vector4());
  const scissor = renderer.getScissor(new THREE.Vector4());
  const scissorTest = renderer.getScissorTest();
  const restoreRenderTarget = captureRenderTarget(renderer);
  const autoClear = renderer.autoClear;
  const clearColor = renderer.getClearColor(Object.assign(new THREE.Color(), { a: 1 }));
  const clearAlpha = renderer.getClearAlpha();
  const native = 'isWebGPURenderer' in renderer ? renderer : null;
  const renderObject = native?.getRenderObjectFunction();
  const mrt = native?.getMRT();
  const background = scene.background;
  const hasBackgroundNode = 'backgroundNode' in scene;
  const backgroundNode = hasBackgroundNode ? scene.backgroundNode : undefined;
  const overrideMaterial = scene.overrideMaterial;
  const sceneName = scene.name;
  const globalShadow = 'autoUpdate' in renderer.shadowMap ? renderer.shadowMap : null;
  const globalAutoUpdate = globalShadow?.autoUpdate;
  const globalNeedsUpdate = globalShadow?.needsUpdate;
  const shadows: { shadow: THREE.LightShadow; layers: number; autoUpdate: boolean; needsUpdate: boolean; remainingUpdate?: boolean }[] = [];
  let rendered = false;
  try {
    withPreparedModel(scene, model, () => {
      if (renderer.shadowMap.enabled) {
        scene.traverseVisible((object) => {
          const light = object as THREE.Light & { shadow?: THREE.LightShadow };
          if (light.isLight && light.castShadow && light.shadow && light.layers.test(camera.layers)) {
            const shadow = light.shadow;
            shadows.push({ shadow, layers: shadow.camera.layers.mask, autoUpdate: shadow.autoUpdate, needsUpdate: shadow.needsUpdate });
            shadow.needsUpdate = true;
          }
        });
        if (globalShadow) globalShadow.needsUpdate = true;
      }
      renderer.autoClear = false;
      // Color backgrounds force a framebuffer clear even with autoClear=false;
      // viewport clipping alone cannot keep that clear off the visible canvas.
      if (scene.background && 'isColor' in scene.background) scene.background = null;
      renderer.setViewport(0, 0, 0, 0);
      renderer.render(scene, camera);
      rendered = true;
      for (const state of shadows) state.remainingUpdate = state.shadow.needsUpdate;
    });
  } finally {
    // Restore public state even when a native nested shadow draw throws before
    // Three's own restoration. The draw never changes authored layers/materials.
    restoreRenderTarget();
    renderer.setViewport(viewport);
    renderer.setScissor(scissor);
    renderer.setScissorTest(scissorTest);
    renderer.setClearColor(clearColor, clearAlpha);
    renderer.autoClear = autoClear;
    if (native) { native.setRenderObjectFunction(renderObject ?? null); native.setMRT(mrt ?? null); }
    scene.background = background;
    if (hasBackgroundNode) Object.assign(scene, { backgroundNode });
    else Reflect.deleteProperty(scene, 'backgroundNode');
    scene.overrideMaterial = overrideMaterial;
    scene.name = sceneName;
    for (const { shadow, layers, autoUpdate, needsUpdate, remainingUpdate } of shadows) {
      shadow.camera.layers.mask = layers;
      shadow.autoUpdate = autoUpdate;
      shadow.needsUpdate = rendered ? needsUpdate || !!remainingUpdate : true;
    }
    if (globalShadow) {
      globalShadow.autoUpdate = globalAutoUpdate!;
      globalShadow.needsUpdate = rendered ? globalNeedsUpdate! : true;
    }
  }
  // Cancellation can arrive between this synchronous draw and readiness
  // settlement. The host will not reveal that model, so its static maps expire.
  return () => {
    for (const { shadow } of shadows) shadow.needsUpdate = true;
    if (globalShadow && renderer.shadowMap.enabled) globalShadow.needsUpdate = true;
  };
}
