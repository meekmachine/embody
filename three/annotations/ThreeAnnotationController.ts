import * as THREE from 'three';
import { initEmbodyCore, requireInitializedEmbodyCore } from '@lovelace_lol/embody/wasm';
import type { CharacterSceneRenderer } from '../scene';
import { bindSceneRendering, reportSceneRenderingFailure } from '../sceneRenderingBinding';
import { prepareModelSkinning } from '../modelSkinning';
import { compileModelForRender, drawModelForRender } from './modelRenderPreparation';
import { resolveAnnotationCharacterConfig } from './adapter';
import { CameraDOMControls } from './DOMControls';
import { ThreeAnnotationControls } from './ThreeAnnotationControls';
import { ThreeAnnotationRenderer } from './ThreeAnnotationRenderer';
import { AnnotationModelObserver } from './modelObservation';
import { intersectMeshesInSlices } from './markerSurfaceRaycast';
import { waitForCharacterLoadPaint } from './loadFrame';
import { annotationConfigInput, annotationProfileInput, type AnnotationSnapshot, type NativeAnnotationRuntime, type SurfaceQuery } from './runtime';
import type { ThreeAnnotationControllerConfig, CharacterConfig, AnnotationAnchoredRegion, CameraState, MarkerStyle, MarkerStyleOverrides, LineConfig, ExpandedRegionState, RuntimeAnnotationOptions, RuntimeAnnotationRegionSummary, RegionChangeCallback } from './types';

export interface MarkerStateSnapshot { visible: boolean; style: MarkerStyle; }
interface ModelRenderPreparation { promise: Promise<void>; draw: (() => void) | null; cancel: (reason: Error) => void; }
function renderPreparationAborted(): Error { const error = new Error('Model render preparation was cancelled.'); error.name = 'AbortError'; return error; }

/** Native resource owner for one Rust AnnotationRuntime. Await create() or initialize Wasm before construction. */
export class ThreeAnnotationController {
  readonly camera: THREE.PerspectiveCamera;
  readonly scene: THREE.Scene;
  readonly controls: ThreeAnnotationControls;
  private readonly runtime: NativeAnnotationRuntime;
  private readonly markerRenderer: ThreeAnnotationRenderer;
  private readonly resolveCharacterConfig: NonNullable<ThreeAnnotationControllerConfig['resolveCharacterConfig']>;
  private readonly selectRegion?: (name: string) => void;
  private domElement: HTMLElement;
  private readonly manageCamera: boolean;
  private observer: AnnotationModelObserver | null = null;
  private hostConfig: CharacterConfig | null = null;
  private configSnapshot: CharacterConfig | null = null;
  private configSnapshotRevision = -1;
  private configSnapshotHost: CharacterConfig | null = null;
  private state: AnnotationSnapshot;
  private domControls: CameraDOMControls | null = null;
  private disposed = false;
  private fallbackFrame: number | null = null;
  private readonly flights = new Map<number, () => void>();
  private readonly markerStateListeners = new Set<(state: MarkerStateSnapshot) => void>();
  private readonly regionListeners = new Set<RegionChangeCallback>();
  private renderer: CharacterSceneRenderer | null = null;
  private renderFrame: ThreeAnnotationControllerConfig['renderFrame'];
  private resizeRenderer: ThreeAnnotationControllerConfig['resizeRenderer'];
  private onRenderError: ThreeAnnotationControllerConfig['onRenderError'];
  private renderingSuspended = false;
  private unbindRendering: (() => Promise<void> | null) | null = null;
  private renderingFailure: ((error: unknown) => void) | null = null;
  private framePending = false;
  private frameCompletion: Promise<void> | null = null;
  private modelPreparation: ModelRenderPreparation | null = null;
  private renderFailed = false;
  private resizeObserver: ResizeObserver | null = null;
  private boundResizeHandler: (() => void) | null = null;

  static async create(config: ThreeAnnotationControllerConfig): Promise<ThreeAnnotationController> { await initEmbodyCore(); return new ThreeAnnotationController(config); }
  constructor(config: ThreeAnnotationControllerConfig, nativeOptions: { captureInput?: boolean; manageCamera?: boolean; markerDefaults?: unknown } = {}) {
    const core = requireInitializedEmbodyCore();
    const settings = Object.fromEntries(['enableDamping', 'dampingFactor', 'minDistance', 'maxDistance', 'transitionDuration', 'zoomPaddingFactor', 'closeUpPaddingFactor', 'fullBodyPaddingFactor'].map(key => [key, config[key as keyof ThreeAnnotationControllerConfig]]));
    this.runtime = new core.AnnotationRuntime(JSON.stringify({ ...settings, markerDefaults: nativeOptions.markerDefaults }));
    this.camera = config.camera; this.scene = config.scene; this.domElement = config.domElement;
    this.manageCamera = nativeOptions.manageCamera ?? true;
    this.resolveCharacterConfig = config.resolveCharacterConfig ?? resolveAnnotationCharacterConfig;
    this.selectRegion = config.onRegionSelect;
    this.controls = new ThreeAnnotationControls(config.domElement, this.runtime, () => { this.update(); this.requestFrame(); }, nativeOptions.captureInput);
    this.state = this.readState();
    if (this.manageCamera) this.applyCameraState(this.state.camera);
    else this.controls.target.copy(this.camera.getWorldDirection(new THREE.Vector3()).add(this.camera.position));
    this.markerRenderer = new ThreeAnnotationRenderer(this.runtime, this.scene, this.camera, this.domElement, ids => this.pick(ids), id => { if (!this.disposed) { this.call('hover', { id }); this.update(); } });
    if (config.showDOMControls ?? true) this.domControls = new CameraDOMControls({ container: config.controlsContainer ?? (config.rendering && config.domElement.tagName === 'CANVAS' ? config.domElement.parentElement ?? config.domElement : config.domElement), regions: [], markersVisible: this.state.visible, onRegionSelect: name => this.select(name), onMarkersVisibleChange: visible => this.setMarkersVisible(visible) });
    this.update();
    this.renderFrame = config.renderFrame;
    this.resizeRenderer = config.resizeRenderer;
    this.onRenderError = config.onRenderError;
    if (config.rendering) {
      const rendering = config.rendering;
      this.renderingFailure = (error) => reportSceneRenderingFailure(rendering, error, this.renderer);
      this.unbindRendering = bindSceneRendering(config.rendering, this.scene, this.camera, {
        suspend: async () => {
          this.renderingSuspended = true;
          const preparation = this.modelPreparation;
          this.cancelModelPreparation();
          // A lost device can reject loop shutdown. Still drain every borrower
          // before allowing the scene owner to release its model resources.
          let stopping: Promise<void>;
          try { stopping = Promise.resolve(this.renderer?.setAnimationLoop(null)); }
          catch (failure) { stopping = Promise.reject(failure); }
          const [stopped] = await Promise.allSettled([
            stopping,
            this.frameCompletion,
            preparation?.promise,
          ]);
          if (stopped.status === 'rejected') throw stopped.reason;
        },
        prepare: async (renderer) => {
          if (this.disposed) throw renderPreparationAborted();
          const model = this.observer?.model;
          if (model) {
            await compileModelForRender(renderer, this.scene, this.camera, model);
            if (this.disposed || model !== this.observer?.model) throw renderPreparationAborted();
            drawModelForRender(renderer, this.scene, this.camera, model);
          } else renderer.render(this.scene, this.camera);
        },
        commit: async (renderer) => {
          if (this.disposed) throw renderPreparationAborted();
          this.cleanupResizeHandling();
          this.controls.disconnect();
          this.controls.connect(renderer.domElement);
          this.domElement = renderer.domElement;
          this.markerRenderer.setDomElement(renderer.domElement);
          this.renderer = renderer;
          this.renderFailed = false;
          this.renderingSuspended = false;
          this.setupResizeHandling();
          this.boundResizeHandler?.();
          await this.startRenderLoop(true);
          if (this.disposed) { this.stopRenderLoop(); throw renderPreparationAborted(); }
        },
        onError: (error) => this.handleRenderError(error),
      });
    } else if (config.renderer) {
      this.renderer = config.renderer;
      void this.startRenderLoop();
      this.setupResizeHandling();
    }

  }
  private readState(): AnnotationSnapshot { return JSON.parse(this.runtime.snapshot()) as AnnotationSnapshot; }
  private call<T = void>(operation: string, payload: unknown = {}): T { if (this.disposed) throw new Error('Annotation controller is disposed.'); return JSON.parse(this.runtime.command(operation, JSON.stringify(payload), performance.now())) as T; }
  private sync(): void {
    if (this.disposed || this.runtime.revision() === this.state.revision) return;
    const previous = this.state; this.state = this.readState();
    this.markerRenderer.sync(this.state);
    this.domControls?.updateRegions(this.state.regions, this.state.currentRegion ?? undefined);
    this.domControls?.setMarkersVisible(this.state.visible);
    if (previous.currentRegion !== this.state.currentRegion && this.state.currentRegion) for (const listener of this.regionListeners) listener(this.state.currentRegion);
    if (previous.visible !== this.state.visible || previous.style !== this.state.style) for (const listener of this.markerStateListeners) listener({ visible: this.state.visible, style: this.state.style });
  }
  private applyCameraState(state: CameraState): void { this.camera.position.fromArray(state.position); this.controls.target.fromArray(state.target); this.camera.lookAt(this.controls.target); this.camera.updateMatrixWorld(); }
  private isCurrent(generation: number): boolean { return !this.disposed && this.runtime.is_current(generation); }
  private requestFrame(): void {
    if (this.disposed || this.renderer || this.fallbackFrame !== null || !this.runtime.needs_frame()) return;
    this.fallbackFrame = requestAnimationFrame(() => { this.fallbackFrame = null; this.update(); this.requestFrame(); });
  }
  private settleFlights(): void {
    const completed = this.runtime.completed_camera_request();
    for (const [id, resolve] of this.flights) if (id <= completed) { this.flights.delete(id); resolve(); }
  }
  private waitForFlight(id: number | null): Promise<void> {
    if (id === null || this.disposed) return Promise.resolve();
    if (this.manageCamera) this.applyCameraState(this.readState().camera); this.sync(); this.settleFlights();
    if (id <= this.runtime.completed_camera_request()) return Promise.resolve();
    const promise = new Promise<void>(resolve => this.flights.set(id, resolve)); this.requestFrame(); return promise;
  }
  private select(name: string): void { if (this.selectRegion) this.selectRegion(name); else void this.focusRegion(name); }
  private pick(ids: number[]): void { if (this.disposed) return; const name = this.call<string | null>('pick', { ids }); this.sync(); this.requestFrame(); if (name) this.select(name); }
  setModel(model: THREE.Object3D): void {
    if (this.disposed) return;
    prepareModelSkinning(model);
    this.cancelModelPreparation();
    const observer = new AnnotationModelObserver(model);
    this.runtime.set_model(JSON.stringify(observer.capture())); this.observer = observer; this.markerRenderer.setMeshes(observer.meshes); this.hostConfig = null; this.configSnapshot = null; this.configSnapshotHost = null;
    this.settleFlights(); this.sync();
  }
  /** Drop native and Rust model observations before the host releases its model under a rendering lease. */
  clearModel(): void {
    if (this.disposed) return;
    this.cancelModelPreparation(); this.call('clearModel');
    this.observer = null; this.hostConfig = null; this.configSnapshot = null; this.configSnapshotHost = null; this.markerRenderer.setMeshes([]);
    this.settleFlights(); this.sync();
  }
  getModel(): THREE.Object3D | null { return this.observer?.model ?? null; }
  async loadRegions(config: CharacterConfig): Promise<void> {
    if (this.disposed) return;
    const generation = this.call<number>('beginLoad'); this.settleFlights();
    const resolved = await this.resolveCharacterConfig(config);
    if (!this.isCurrent(generation)) return;
    await this.prepareRegionsAndMarkersForReveal(resolved);
  }
  private configure(config: CharacterConfig): void {
    this.cancelModelPreparation(); this.call('configure', { config: annotationConfigInput(config) }); this.hostConfig = config; this.settleFlights(); this.sync();
  }
  prepareRegionsForReveal(config: CharacterConfig): void { if (this.disposed) return; this.configure(config); this.startConfiguredCamera(); }
  async prepareRegionsAndMarkersForReveal(config: CharacterConfig, beforeReveal?: () => Promise<boolean>): Promise<void> {
    if (this.disposed) return; this.configure(config); const generation = this.runtime.generation();
    await this.loadMarkersForCurrentRegions(true);
    if (!this.isCurrent(generation)) return;
    if (beforeReveal && !await beforeReveal()) return;
    if (this.isCurrent(generation)) this.startConfiguredCamera();
  }
  private startConfiguredCamera(): void { this.update(); this.observer?.observeFocus(this.runtime, { configured: true }); void this.waitForFlight(this.call<number | null>('startConfigured')); }
  async loadMarkersForCurrentRegions(sliceSurfaceQueries = false): Promise<void> {
    if (this.disposed || !this.observer) return;
    const observer = this.observer; const generation = this.runtime.generation();
    observer.observe(this.runtime);
    const queries = JSON.parse(this.runtime.plan_markers(JSON.stringify(observer.morphAnchors(this.runtime)))) as SurfaceQuery[];
    for (const initial of queries) {
      let query: SurfaceQuery | null = initial;
      while (query && this.isCurrent(generation)) {
        const raycaster = new THREE.Raycaster(new THREE.Vector3().fromArray(query.origin), new THREE.Vector3().fromArray(query.direction), 0, query.far);
        const hits = sliceSurfaceQueries
          ? await intersectMeshesInSlices(raycaster, observer.meshes, { isCurrent: () => this.isCurrent(generation), yieldToPaint: waitForCharacterLoadPaint })
          : raycaster.intersectObjects(observer.meshes, false);
        if (!hits || !this.isCurrent(generation)) return;
        query = JSON.parse(this.runtime.surface_result(query.generation, query.id, query.phase, new Float32Array(hits.flatMap(hit => hit.point.toArray())))) as SurfaceQuery | null;
        if (sliceSurfaceQueries && query) await waitForCharacterLoadPaint();
      }
    }
    if (!this.isCurrent(generation)) return;
    this.runtime.finish_markers(generation); this.sync(); this.update(); this.requestFrame();
  }
  private rebuild(): void { void this.loadMarkersForCurrentRegions().catch(error => this.handleRenderError(error)); }
  focusRegion(name: string, duration?: number): Promise<void> { return this.focus({ name, duration }); }
  focusBones(bones: string[], duration?: number): Promise<void> { return this.focus({ region: { bones }, duration }); }
  focusMeshes(meshes: string[], duration?: number): Promise<void> { return this.focus({ region: { meshes }, duration }); }
  focusFullBody(duration?: number): Promise<void> { return this.focus({ region: { objects: ['*'] }, duration }); }
  focusObjects(objects: THREE.Object3D[], duration?: number): Promise<void> { return this.focus({ region: { objectIds: objects.flatMap(object => { const id = this.observer?.id(object); return id === undefined ? [] : [id]; }) }, duration }); }
  private focus(request: unknown): Promise<void> { if (this.disposed) return Promise.resolve(); this.update(); this.observer?.observeFocus(this.runtime, request); return this.waitForFlight(this.call<number | null>('focus', request)); }
  playIntroAnimation(orbitDuration = 3000, zoomDuration = 1500): Promise<void> { if (this.disposed) return Promise.resolve(); this.update(); this.observer?.observeFocus(this.runtime, { intro: true }); return this.waitForFlight(this.call<number | null>('intro', { orbitDuration, zoomDuration })); }
  animateToCameraState(state: CameraState, duration?: number): Promise<void> { if (this.disposed) return Promise.resolve(); return this.waitForFlight(this.call<number>('animateCamera', { ...state, duration })); }
  getCameraState(): CameraState { return { position: this.camera.position.toArray(), target: this.controls.target.toArray() }; }
  setCameraState(state: CameraState): void { if (this.disposed) return; this.call('setCamera', state); this.applyCameraState(this.readState().camera); this.settleFlights(); this.sync(); this.controls.notifyChange(); }
  getRegionNames(): string[] { return this.getAnnotationRegions().map(region => region.name); }
  getCurrentRegion(): string | null { return this.state.currentRegion; }
  getCharacterConfig(): CharacterConfig | null {
    if (!this.hostConfig) return null;
    // React consumers observe this snapshot. Camera/hover frames must not create
    // a new profile identity or trigger another round of editor effects.
    if (this.configSnapshotRevision !== this.state.configRevision || this.configSnapshotHost !== this.hostConfig) {
      this.configSnapshot = { ...this.hostConfig, ...this.state.config };
      this.configSnapshotRevision = this.state.configRevision;
      this.configSnapshotHost = this.hostConfig;
    }
    return this.configSnapshot;
  }
  getAnnotationRegions(): AnnotationAnchoredRegion[] { return structuredClone(this.state.regions); }
  getAnnotationRegion(name: string): AnnotationAnchoredRegion | undefined { return this.getAnnotationRegions().find(region => region.name === name); }
  setCurrentRegion(name: string | null): void { if (this.disposed) return; this.call('select', { name }); this.sync(); }
  getMarkersVisible(): boolean { return this.state.visible; }
  setMarkersVisible(visible: boolean): void {
    if (this.disposed) return;
    this.call('visibility', { visible });
    this.sync();
    // Region preparation defers native marker construction until the first
    // reveal. Rust's loaded state prevents rebuilding on later visibility edits.
    if (visible && !this.state.loaded && this.hostConfig) this.rebuild();
    this.update(); this.requestFrame();
  }
  getMarkerStyle(): MarkerStyle { return this.state.style; }
  setMarkerStyle(style: MarkerStyle): void { if (this.disposed) return; this.call('style', { style }); this.sync(); this.update(); }
  clearMarkers(): void { if (this.disposed) return; this.cancelModelPreparation(); this.call('clear'); this.hostConfig = null; this.configSnapshot = null; this.configSnapshotHost = null; this.settleFlights(); this.sync(); }
  subscribeMarkerState(listener: (state: MarkerStateSnapshot) => void): () => void { this.markerStateListeners.add(listener); listener({ visible: this.state.visible, style: this.state.style }); return () => { this.markerStateListeners.delete(listener); }; }
  onRegionChange(listener: RegionChangeCallback): () => void { this.regionListeners.add(listener); return () => { this.regionListeners.delete(listener); }; }
  soloMarker(name: string | null): void { if (this.disposed) return; this.call('solo', { name }); this.sync(); this.update(); }
  getSoloedMarker(): string | null { return this.state.solo; }
  expandRegion(name: string, duration?: number): void { this.expandCommand('expand', name, duration); }
  setRegionExpansion(name: string, expanded: boolean, animation: 'outward' | 'staggered' = 'outward', duration?: number): void { this.expandCommand(expanded ? 'expand' : 'collapse', name, duration, animation); }
  collapseRegion(name: string, duration?: number): void { this.expandCommand('collapse', name, duration); }
  toggleRegion(name: string, animation: 'outward' | 'staggered' = 'outward', duration?: number): void { this.expandCommand('toggle', name, duration, animation); }
  private expandCommand(operation: string, name: string, duration?: number, animation?: string): void { if (this.disposed) return; this.call(operation, { name, duration, animation }); this.sync(); this.update(); this.requestFrame(); }
  getExpandedRegions(): ExpandedRegionState[] { return structuredClone(this.state.expanded); }
  setRegionLineStyle(name: string, line: Partial<LineConfig>): void { this.updateAnnotationRegion(name, { style: { line } }); }
  setRegionStyle(name: string, style: Partial<MarkerStyleOverrides>): void { this.updateAnnotationRegion(name, { style }); }
  updateRegionMeshes(name: string, meshes: string[]): void { this.updateAnnotationRegion(name, { meshes }); }
  repositionMarker(name: string, position: { x: number; y: number; z: number }): void { this.updateAnnotationRegion(name, { markerAnchor: { type: 'point', position } }); }
  getMarkerPosition(name: string): { x: number; y: number; z: number } | null { return this.disposed ? null : this.call('markerPosition', { name }); }
  updateAnnotationRegion(name: string, update: Partial<AnnotationAnchoredRegion>): void { if (this.disposed) return; this.call('updateRegion', { name, update: JSON.parse(JSON.stringify(update, (_key, value) => value === undefined ? null : value)) }); this.sync(); this.rebuild(); }
  removeAnnotationRegion(name: string): void { if (this.disposed) return; this.call('removeRegion', { name }); this.sync(); this.rebuild(); }
  showRuntimeBoneAnnotation(boneName: string, options: RuntimeAnnotationOptions = {}): RuntimeAnnotationRegionSummary { const result = this.call<RuntimeAnnotationRegionSummary>('runtimeBone', { target: boneName, options }); this.sync(); this.rebuild(); return result; }
  showRuntimeAUAnnotations(auId: string | number, profile?: unknown, options: RuntimeAnnotationOptions = {}, morphTargetsByMesh?: unknown): RuntimeAnnotationRegionSummary[] { const result = this.call<RuntimeAnnotationRegionSummary[]>('runtimeAU', { target: String(auId), profile: annotationProfileInput(profile), options, meshes: morphTargetsByMesh }); this.sync(); this.rebuild(); return result; }
  clearRuntimeAnnotations(): string[] { if (this.disposed) return []; const names = this.call<string[]>('clearRuntime'); this.sync(); this.rebuild(); return names; }
  setDOMControlsVisible(visible: boolean): void { this.domControls?.setVisible(visible); }
  updateDOMControls(): void { this.domControls?.updateRegions(this.state.regions, this.state.currentRegion ?? undefined); this.domControls?.setMarkersVisible(this.state.visible); }
  update(): void {
    if (this.disposed) return;
    const rect = this.domElement.getBoundingClientRect(); const now = performance.now();
    const pose = this.runtime.camera_frame(now, new Float32Array([...this.camera.position.toArray(), ...this.controls.target.toArray(), this.camera.fov, this.camera.aspect, rect.width, rect.height]));
    if (this.manageCamera && pose.length >= 6) { this.camera.position.fromArray(pose); this.controls.target.fromArray(pose, 3); this.camera.lookAt(this.controls.target); }
    if (this.observer) this.runtime.observe_transforms(this.observer.transforms(this.runtime));
    this.sync(); this.markerRenderer.update(now); this.settleFlights();
    if (pose[9] === 1) this.controls.notifyChange();
  }
  dispose(): void {
    if (this.disposed) return; this.disposed = true; this.cancelModelPreparation(); this.stopRenderLoop(); this.cleanupResizeHandling();
    const renderingSettled = this.unbindRendering?.(); this.unbindRendering = null;
    if (this.fallbackFrame !== null) cancelAnimationFrame(this.fallbackFrame); this.fallbackFrame = null;
    this.controls.dispose();
    // A candidate renderer may still be compiling these borrowed marker resources.
    if (renderingSettled) void renderingSettled.then(() => this.markerRenderer.dispose());
    else this.markerRenderer.dispose();
    this.domControls?.dispose(); this.domControls = null;
    this.runtime.dispose(); this.runtime.free(); this.observer = null; this.hostConfig = null; this.configSnapshot = null; this.configSnapshotHost = null;
    for (const resolve of this.flights.values()) resolve(); this.flights.clear(); this.markerStateListeners.clear(); this.regionListeners.clear();
  }
  private startRenderLoop(propagateFailure = false): void | Promise<void> {
    if (!this.renderer) return;
    const renderer = this.renderer;
    try {
      const started = renderer.setAnimationLoop(() => {
        if (this.disposed || this.renderFailed || this.renderingSuspended || this.framePending || renderer !== this.renderer) return;
        try {
          // Native shadows are updated once per camera/frame. Prepare the full
          // scene first and leave its pixels untouched until the next frame.
          const preparationDraw = this.modelPreparation?.draw;
          if (preparationDraw) { preparationDraw(); return; }
          this.update();
          const frame = this.renderFrame
            ? this.renderFrame(this.renderer!, this.scene, this.camera)
            : this.renderer!.render(this.scene, this.camera);
          if (frame) {
            this.framePending = true;
            this.frameCompletion = Promise.resolve(frame).then(
              () => { this.framePending = false; },
              (error) => { this.framePending = false; this.handleRenderError(error); },
            );
          }
        } catch (error) { this.handleRenderError(error); }
      });
      if (started) return started.catch((error) => {
        if (propagateFailure) throw error;
        if (renderer === this.renderer) this.handleRenderError(error);
      });
    } catch (error) {
      if (propagateFailure) throw error;
      this.handleRenderError(error);
    }
  }

  private handleRenderError(error: unknown): void {
    if (this.disposed || this.renderFailed) return;
    this.renderFailed = true;
    this.cancelModelPreparation(error instanceof Error ? error : new Error(String(error)));
    this.stopRenderLoop();
    const failure = error instanceof Error ? error : new Error(String(error));
    if (this.renderingFailure) { this.renderingFailure(failure); return; }
    try {
      if (this.onRenderError) this.onRenderError(failure);
      else console.error('Character camera render loop failed.', failure);
    } catch (callbackError) {
      console.error('Character camera render-error callback failed.', callbackError);
    }
  }

  /**
   * Stop the render loop
   */
  private stopRenderLoop(): void {
    try {
      const stopped = this.renderer?.setAnimationLoop(null);
      if (stopped) void stopped.catch((error) => console.error('Character camera render loop stop failed.', error));
    } catch (error) { console.error('Character camera render loop stop failed.', error); }
  }

  private setupResizeHandling(): void {
    if (!this.renderer) return;

    const container = this.domElement.parentElement || this.domElement;

    // Create resize handler
    this.boundResizeHandler = () => {
      const width = container.clientWidth || window.innerWidth;
      const height = container.clientHeight || window.innerHeight;

      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();

      if (this.renderer) {
        if (this.resizeRenderer) {
          this.resizeRenderer(this.renderer, width, height);
        } else {
          this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
          this.renderer.setSize(width, height, false);
        }
      }
    };

    // Use ResizeObserver for container size changes
    this.resizeObserver = new ResizeObserver(this.boundResizeHandler);
    this.resizeObserver.observe(container);

    // Also listen to window resize as fallback
    window.addEventListener('resize', this.boundResizeHandler);
  }

  /**
   * Clean up resize handling
   */
  private cleanupResizeHandling(): void {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this.boundResizeHandler) {
      window.removeEventListener('resize', this.boundResizeHandler);
      this.boundResizeHandler = null;
    }
  }

  // ====== CORE PUBLIC METHODS ======

  /**
   * Prepare the currently visible material variants before first reveal.
   * Borrows model/renderer; callers retain them until this promise settles,
   * including after cancellation or controller disposal.
   */
  prepareModelForRender(model: THREE.Object3D, options: { signal?: AbortSignal } = {}): Promise<void> {
    if (this.disposed || options.signal?.aborted) return Promise.reject(renderPreparationAborted());
    if (this.renderingSuspended) return Promise.reject(new Error('Model render preparation is unavailable during renderer replacement.'));
    if (!this.renderer || this.renderFailed) return Promise.reject(new Error('Model render preparation requires an active controller-owned renderer.'));
    const renderer = this.renderer;
    const previous = this.modelPreparation;
    previous?.cancel(renderPreparationAborted());
    let cancelled: Error | null = null;
    let invalidatePreparedShadows: (() => void) | null = null;
    let rejectDraw: ((error: Error) => void) | null = null;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const request: ModelRenderPreparation = {
      promise, draw: null,
      cancel: (reason) => {
        cancelled ??= reason;
        invalidatePreparedShadows?.();
        request.draw = null;
        rejectDraw?.(cancelled);
      },
    };
    this.modelPreparation = request;
    const abort = () => request.cancel(renderPreparationAborted());
    options.signal?.addEventListener('abort', abort, { once: true });
    const checkCancelled = () => { if (cancelled) throw cancelled; };
    void (async () => {
      try {
        // Supersession never compiles over a predecessor's borrowed objects.
        if (previous) await previous.promise.catch(() => undefined);
        // A host callback may have started while the predecessor was settling.
        // Read its current completion here, immediately before acquiring state.
        if (this.framePending && this.frameCompletion) await this.frameCompletion;
        checkCancelled();
        const compilation = compileModelForRender(renderer, this.scene, this.camera, model);
        try { await compilation; }
        catch (error) { throw cancelled ?? error; }
        checkCancelled();
        await new Promise<void>((done, failed) => {
          rejectDraw = failed;
          request.draw = () => {
            request.draw = null;
            try {
              checkCancelled();
              invalidatePreparedShadows = drawModelForRender(renderer, this.scene, this.camera, model);
              checkCancelled();
              done();
            } catch (error) { invalidatePreparedShadows?.(); failed(cancelled ?? error); }
          };
        });
        checkCancelled();
      } finally {
        options.signal?.removeEventListener('abort', abort);
        if (this.modelPreparation === request) this.modelPreparation = null;
      }
    })().then(resolve, reject);
    return promise;
  }

  private cancelModelPreparation(reason = renderPreparationAborted()): void {
    this.modelPreparation?.cancel(reason);
  }

  /**
   * Set the model to use for bone/mesh lookups
   * Must be called after model loads
   */

}
