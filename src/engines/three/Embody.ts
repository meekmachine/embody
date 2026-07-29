/**
 * Embody - Three.js Implementation
 *
 * Default implementation of the Embody runtime interface for Three.js.
 * Controls 3D character facial animation using Action Units (AUs),
 * morph targets, visemes, and bone transformations.
 */

import {
  BufferAttribute,
  Vector3,
  Box3,
  Clock,
} from 'three';
import type { Mesh, Object3D, AnimationClip } from 'three';
import type {
  EmbodyRuntime,
  ReadyPayload,
  EmbodyConfig,
} from '../../interfaces/EmbodyRuntime';
import type { MeshInfo, MorphTargetRef, Profile } from '../../mappings/types';
import type {
  TransitionHandle,
  BoneKey,
  AnimationPlayOptions,
  AnimationClipInfo,
  AnimationState,
  AnimationActionHandle,
  CurvesMap,
  ClipOptions,
  ClipHandle,
  Snippet,
  SnippetChannel,
  TypedSnippet,
  CompositeRotation,
  AnimationBlendMode,
  MorphTargetDelta,
  AddMorphTargetOptions,
} from '../../core/types';
import { ThreeAnimationRuntime, ThreeAnimationSystem } from './ThreeAnimationRuntime';
import { ThreeModelInspector } from './ThreeModelInspector';
import { ThreeFrameApplier, type ThreeFrameApplierBindings, type ThreeMaterialConfig, type ThreeResolvedMaterialConfig } from './ThreeFrameApplier';
import { WasmRuntimeCore } from '../../core/WasmRuntimeCore';
import type { ModelDescriptor } from '../../core/contracts';
import { initEmbodyCore, requireInitializedEmbodyCore } from '../../wasm';
import { HairPhysicsController, type HairPhysicsConfig, type HairPhysicsConfigUpdate } from './hair/HairPhysicsController';
import { CC4_MESHES } from '../../presets/cc4';
import { getPreset } from '../../presets';
import { mergePresetWithProfile } from '../../mappings/extendPresetWithProfile';
import {
  getProfileVisemeSlots,
  getMeshNamesForAUProfile,
  getMeshNamesForVisemeProfile,
  getVisemeBindingTargets,
  getVisemeJawAmounts,
  getVisemeSlotIndex,
} from '../../mappings/visemeSystem';
import type { ResolvedBones } from './types';

function clamp01(x: number) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

type MorphTargetHandle = { infl: number[]; idx: number };
type WeightedMorphTargetHandle = MorphTargetHandle & { weight: number };
type ResolvedMorphTargetsBySide = {
  left: MorphTargetHandle[];
  right: MorphTargetHandle[];
  center: MorphTargetHandle[];
};

export class Embody implements EmbodyRuntime {
  // Optional hook for animation schedulers.
  onSnippetEnd?: (name: string) => void;

  /**
   * Create an engine with Rust-owned preset/profile resolution.
   *
   * Prefer this factory whenever a profile patch must be merged onto a preset.
   * The sync constructor accepts either a presetType with no patch, or an
   * already-resolved profile.
   */
  static async create(
    config: EmbodyConfig = {},
    animation?: {
      tick(dtSeconds: number): void;
      addTransition(
        key: string,
        from: number,
        to: number,
        durationMs: number,
        apply: (value: number) => void,
        easing?: (t: number) => number
      ): TransitionHandle;
      clearTransitions(): void;
      getActiveTransitionCount(): number;
    }
  ): Promise<Embody> {
    const core = await initEmbodyCore();
    const basePreset = getPreset(config.presetType || 'cc4');
    const resolvedProfile = mergePresetWithProfile(core, basePreset, config.profile);
    const engine = new Embody(
      {
        profile: resolvedProfile,
        animationRuntimeFactory: config.animationRuntimeFactory,
      },
      animation
    );
    engine.attachWasmCore(core);
    return engine;
  }

  // Configuration
  private config: Profile;

  // Animation driver (injectable)
  private animation: {
    tick(dtSeconds: number): void;
    addTransition(
      key: string,
      from: number,
      to: number,
      durationMs: number,
      apply: (value: number) => void,
      easing?: (t: number) => number
    ): TransitionHandle;
    clearTransitions(): void;
    getActiveTransitionCount(): number;
  };

  // Composite rotation config (owned by Rust profile; exposed for mixer helpers).
  private compositeRotations: CompositeRotation[];

  // Control mirrors kept for transitions / hair until hosts call Wasm directly.
  private auValues: Record<number, number> = {};
  private auBalances: Record<number, number> = {};
  private rigReady = false;
  private missingBoneWarnings = new Set<string>();
  private isPaused = false;

  // Mesh references
  private faceMesh: Mesh | null = null;
  private resolvedFaceMeshes: string[] = [];
  private meshes: Mesh[] = [];
  private model: Object3D | null = null;
  private meshByName = new Map<string, Mesh>();
  private morphKeyCache = new Map<string, MorphTargetHandle[]>();
  private morphIndexCache = new Map<string, MorphTargetHandle[]>();
  private resolvedAUMorphTargets = new Map<number, ResolvedMorphTargetsBySide>();
  private resolvedVisemeTargets: WeightedMorphTargetHandle[][] = [];

  // Bones
  private bones: ResolvedBones = {};
  private mixWeights: Record<number, number> = {};

  // Viseme state
  private visemeValues: number[] = [];
  private visemeJawScales: number[] = [];


  // Viseme jaw amounts
  private static readonly VISEME_JAW_AMOUNTS: number[] = [
    0.15, 0.35, 0.25, 0.70, 0.55, 0.30, 0.10, 0.20, 0.08,
    0.12, 0.18, 0.02, 0.25, 0.60, 0.40,
  ];

  private animationController: ThreeAnimationSystem;
  private hairPhysics: HairPhysicsController;
  private modelInspector = new ThreeModelInspector();
  private frameApplier = new ThreeFrameApplier();
  private modelDescriptor: ModelDescriptor | null = null;
  private wasmRuntimeCore: WasmRuntimeCore | null = null;
  private framePathReady = false;

  // Internal animation loop
  private clock = new Clock(false); // Don't auto-start
  private animationFrameId: number | null = null;
  private isRunning = false;

  constructor(
    config: EmbodyConfig = {},
    animation?: {
      tick(dtSeconds: number): void;
      addTransition(
        key: string,
        from: number,
        to: number,
        durationMs: number,
        apply: (value: number) => void,
        easing?: (t: number) => number
      ): TransitionHandle;
      clearTransitions(): void;
      getActiveTransitionCount(): number;
    }
  ) {
    // Sync construction does not merge profile patches. Use Embody.create() for
    // preset + override resolution through the Rust Wasm core. Preset lookup and
    // live solving both require await initEmbodyCore() first.
    this.config = config.profile
      ? (config.profile as Profile)
      : getPreset(config.presetType || 'cc4');
    this.mixWeights = { ...this.config.auMixDefaults };
    this.syncVisemeRuntimeState();
    this.animation = animation || new ThreeAnimationRuntime();

    // Composite rotations come from the Rust-owned profile. No host-side preset fallback.
    this.compositeRotations = this.config.compositeRotations || [];

    this.animationController = new ThreeAnimationSystem({
      getModel: () => this.model,
      getMeshes: () => this.meshes,
      getMeshByName: (name) => this.meshByName.get(name),
      getMeshNamesForAU: (auId) => this.getMeshNamesForAU(auId),
      getMeshNamesForViseme: () => this.getMeshNamesForViseme(),
      getCurrentAUValue: (auId) => this.getAU(auId),
      getCurrentVisemeValue: (visemeIndex) => this.visemeValues[visemeIndex] ?? 0,
      getCurrentMorphValue: (morphKey, meshNames) => this.getMorphValueForMeshes(morphKey, meshNames),
      getCurrentMorphIndexValue: (morphIndex, meshNames) => this.getMorphValueByIndexForMeshes(morphIndex, meshNames),
      getCurrentBoneQuaternion: (nodeKey) => this.bones[nodeKey]?.obj.quaternion.clone() ?? null,
      getCurrentBonePositionValue: (nodeKey, axis) => this.bones[nodeKey]?.obj.position[axis] ?? null,
      getBones: () => this.bones,
      getConfig: () => this.config,
      getCompositeRotations: () => this.compositeRotations,
      computeSideValues: (base, balance) => this.computeSideValues(base, balance),
      getAUMixWeight: (auId) => this.getAUMixWeight(auId),
      isMixedAU: (auId) => this.isMixedAU(auId),
      reapplyProceduralState: () => this.reapplyProceduralStateAfterBakedUpdate(),
    }, {
      animationRuntimeFactory: config.animationRuntimeFactory,
    });

    this.hairPhysics = new HairPhysicsController({
      getMeshByName: (name) => this.meshByName.get(name),
      getSelectedHairMeshNames: () => this.config.morphToMesh?.hair || [],
      // Hair physics reuses the shared mixer-backed clip builder.
      buildClip: (clipName, curves, options) => this.animationController.buildClip(clipName, curves, options),
      cleanupSnippet: (name) => this.animationController.cleanupSnippet(name),
    });

    this.applyHairPhysicsProfileConfig();
  }

  // ============================================================================
  // PUBLIC API
  // ============================================================================

  onReady(payload: ReadyPayload): void {
    const { meshes, model } = payload;
    const inspection = this.modelInspector.inspectModel(model, {
      meshes,
      profile: this.config,
      previousBones: this.bones,
    });

    this.meshes = inspection.morphMeshes;
    this.model = model;
    this.meshByName = inspection.meshByName;
    this.morphKeyCache.clear();
    this.morphIndexCache.clear();

    // Resolve bones
    this.bones = inspection.bones;
    this.rigReady = true;
    this.missingBoneWarnings.clear();

    // Find primary face mesh (use head bone proximity when available)
    this.resolvedFaceMeshes = inspection.resolvedFaceMeshes;
    this.faceMesh = inspection.faceMesh;

    // Auto-detect face morph meshes only if preset/profile doesn't define them.
    // When morphToMesh.face is already configured (e.g., CC4 preset specifies
    // body + eyebrows + occlusion + tear lines), trust that configuration.
    //
    // Important: Use only resolved face candidates here. Using all morph-capable
    // meshes makes AU/morph transitions spill into unrelated meshes.
    if (!this.config.morphToMesh?.face || this.config.morphToMesh.face.length === 0) {
      const faceMeshNames = this.resolvedFaceMeshes
        .filter((name) => this.meshByName.has(name));

      if (faceMeshNames.length > 0) {
        this.config.morphToMesh = {
          ...this.config.morphToMesh,
          face: Array.from(new Set(faceMeshNames)),
        };
      }
    }

    this.rebuildMorphTargetsCache();
    this.bindHostNeutralRuntime(inspection);

    if (this.resolvedFaceMeshes.length > 0) {
      for (const faceName of this.resolvedFaceMeshes) {
        const faceMesh = this.meshByName.get(faceName);
        const morphKeys = faceMesh?.morphTargetDictionary
          ? Object.keys(faceMesh.morphTargetDictionary)
          : [];
        console.log('[Embody] Face mesh resolved:', faceName);
        console.log('[Embody] Face mesh morphs:', morphKeys);
      }
    } else {
      console.log('[Embody] No face mesh resolved from morph targets.');
    }

    // Apply render order and material settings from CC4_MESHES
    this.applyMeshMaterialSettings(model);
  }

  private bindHostNeutralRuntime(inspection: ReturnType<ThreeModelInspector['inspectModel']>): void {
    this.modelDescriptor = inspection.descriptor;
    this.frameApplier.setBindings(buildFrameApplierBindings(inspection));

    // Rust/Wasm is required. Hosts must await initEmbodyCore() (or Embody.create())
    // before onReady; there is no TypeScript runtime fallback.
    const wasm = requireInitializedEmbodyCore();
    this.attachWasmCore(wasm);
    this.wasmRuntimeCore = new WasmRuntimeCore({
      profile: this.config,
      model: inspection.descriptor,
      wasm,
    });
    this.syncRuntimeCoreState();
    this.framePathReady = true;
  }

  private attachWasmCore(core: Awaited<ReturnType<typeof initEmbodyCore>>): void {
    this.hairPhysics.setCore(core);
  }

  private syncRuntimeCoreState(): void {
    if (!this.wasmRuntimeCore) return;
    this.wasmRuntimeCore.setProfile(this.config);
    if (this.modelDescriptor) {
      this.wasmRuntimeCore.setModelDescriptor(this.modelDescriptor);
    }
    this.wasmRuntimeCore.clear();
    for (const [auIdText, value] of Object.entries(this.auValues)) {
      const auId = Number(auIdText);
      if (Number.isNaN(auId)) continue;
      this.wasmRuntimeCore.setAU(auId, value, this.auBalances[auId] ?? 0);
    }
    for (const [auIdText, weight] of Object.entries(this.mixWeights)) {
      const auId = Number(auIdText);
      if (Number.isNaN(auId)) continue;
      this.wasmRuntimeCore.setAUMixWeight(auId, weight);
    }
    for (let index = 0; index < this.visemeValues.length; index += 1) {
      this.wasmRuntimeCore.setViseme(
        index,
        this.visemeValues[index] ?? 0,
        this.visemeJawScales[index] ?? 1
      );
    }
  }

  /**
   * Re-inspect the current model and push a fresh ModelDescriptor into the
   * runtime cores and frame applier. Needed whenever host-side morph targets
   * or meshes change after onReady (e.g. addMorphTarget).
   */
  private refreshHostNeutralModelDescriptor(): void {
    if (!this.model || !this.framePathReady) return;
    const inspection = this.modelInspector.inspectModel(this.model, {
      meshes: this.meshes,
      profile: this.config,
      previousBones: this.bones,
    });
    this.modelDescriptor = inspection.descriptor;
    this.frameApplier.setBindings(buildFrameApplierBindings(inspection));
    this.wasmRuntimeCore?.setModelDescriptor(inspection.descriptor);
  }

  private applyLiveFrameDelta(): boolean {
    if (!this.framePathReady || !this.model || !this.wasmRuntimeCore) return false;

    // Restore rest poses first so bones that drop out of the sparse packed
    // delta (for example after a profile remap) do not keep stale transforms.
    for (const entry of Object.values(this.bones)) {
      if (!entry) continue;
      entry.obj.position.set(entry.basePos.x, entry.basePos.y, entry.basePos.z);
      entry.obj.quaternion.copy(entry.baseQuat);
      entry.obj.rotation.setFromQuaternion(entry.obj.quaternion, entry.obj.rotation.order);
    }

    this.frameApplier.applyPackedMorphFrameDelta(
      this.wasmRuntimeCore.evaluatePackedMorphFrameDelta()
    );
    this.frameApplier.applyPackedBoneFrameDelta(
      this.wasmRuntimeCore.evaluatePackedBoneFrameDelta()
    );
    // Bone writes need world matrices refreshed for dependent markers/cameras.
    this.model.updateMatrixWorld(true);
    return true;
  }


  private rebuildMorphTargetsCache(): void {
    this.morphKeyCache.clear();
    this.morphIndexCache.clear();
    this.resolvedAUMorphTargets.clear();
    this.resolvedVisemeTargets = [];

    if (!this.meshes.length) return;

    const resolveTargetsForKeys = (keys: MorphTargetRef[], meshNames: string[]): MorphTargetHandle[] => {
      if (!keys || keys.length === 0) return [];
      const targets: MorphTargetHandle[] = [];
      for (const key of keys) {
        const resolved = typeof key === 'number'
          ? this.resolveMorphTargetsByIndex(key, meshNames)
          : this.resolveMorphTargets(key, meshNames);
        if (resolved.length > 0) {
          targets.push(...resolved);
        }
      }
      return targets;
    };

    for (const [auIdStr, entry] of Object.entries(this.config.auToMorphs || {})) {
      const auId = Number(auIdStr);
      if (Number.isNaN(auId) || !entry) continue;
      const meshNames = this.getMeshNamesForAU(auId);
      const resolved: ResolvedMorphTargetsBySide = {
        left: resolveTargetsForKeys(entry.left, meshNames),
        right: resolveTargetsForKeys(entry.right, meshNames),
        center: resolveTargetsForKeys(entry.center, meshNames),
      };
      this.resolvedAUMorphTargets.set(auId, resolved);
    }

    for (let i = 0; i < getProfileVisemeSlots(this.config).length; i += 1) {
      const visemeMeshNames = this.getMeshNamesForViseme();
      const targets: WeightedMorphTargetHandle[] = [];
      for (const bindingTarget of getVisemeBindingTargets(this.config, i)) {
        const resolved = typeof bindingTarget.morph === 'number'
          ? this.resolveMorphTargetsByIndex(bindingTarget.morph, visemeMeshNames)
          : this.resolveMorphTargets(bindingTarget.morph, visemeMeshNames);
        for (const target of resolved) {
          targets.push({ ...target, weight: bindingTarget.weight });
        }
      }
      this.resolvedVisemeTargets[i] = targets;
    }
  }

  update(deltaSeconds: number): void {
    const dtSeconds = Math.max(0, deltaSeconds || 0);
    if (dtSeconds <= 0 || this.isPaused) return;

    this.animation.tick(dtSeconds);

    // Rust owns live morph/bone solving; Three only applies packed frames.
    if (this.wasmRuntimeCore && this.framePathReady) {
      this.applyLiveFrameDelta();
      this.syncHairFromHeadAus();
    }

    this.animationController.update(dtSeconds);
    this.hairPhysics.update(dtSeconds);
  }

  /** Start the internal animation loop using Three.js Clock */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.clock.start();

    const tick = () => {
      if (!this.isRunning) return;
      const delta = this.clock.getDelta();
      this.update(delta);
      this.animationFrameId = requestAnimationFrame(tick);
    };

    this.animationFrameId = requestAnimationFrame(tick);
  }

  /** Stop the internal animation loop */
  stop(): void {
    this.isRunning = false;
    this.clock.stop();
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  dispose(): void {
    this.stop();
    this.clearTransitions();
    this.animationController.dispose();
    this.meshes = [];
    this.model = null;
    this.bones = {};
    this.modelDescriptor = null;
    this.wasmRuntimeCore = null;
    this.framePathReady = false;
  }

  // ============================================================================
  // AU CONTROL
  // ============================================================================

  setAU(id: number | string, v: number, balance?: number): void {
    if (typeof id === 'string') {
      const match = id.match(/^(\d+)([LR])$/i);
      if (match) {
        const au = Number(match[1]);
        const side = match[2].toUpperCase() as 'L' | 'R';
        const sideBalance = side === 'L' ? -1 : 1;
        this.setAU(au, v, sideBalance);
        return;
      }
      const n = Number(id);
      if (!Number.isNaN(n)) {
        this.setAU(n, v, balance);
      }
      return;
    }

    // Handle negative values for continuum pairs:
    // If v < 0 and this AU has a continuum pair, forward to setContinuum
    if (v < 0 && this.config.continuumPairs) {
      const pairInfo = this.config.continuumPairs[id];
      if (pairInfo) {
        const negAU = pairInfo.isNegative ? id : pairInfo.pairId;
        const posAU = pairInfo.isNegative ? pairInfo.pairId : id;
        const continuumValue = pairInfo.isNegative ? -v : v;
        this.setContinuum(negAU, posAU, continuumValue, balance);
        return;
      }
    }

    this.auValues[id] = v;
    // Store balance for this AU (used by bilateral bone AUs like fish gills)
    if (balance !== undefined) {
      this.auBalances[id] = balance;
    }

    // Before onReady, only record state. Live writes require the Rust core.
    if (!this.wasmRuntimeCore || !this.framePathReady) {
      return;
    }

    this.wasmRuntimeCore.setAU(id, v, balance ?? this.auBalances[id] ?? 0);
    this.applyLiveFrameDelta();
  }

  transitionAU(id: number | string, to: number, durationMs = 200, balance?: number): TransitionHandle {
    const numId = typeof id === 'string' ? Number(id.replace(/[^\d]/g, '')) : id;

    // Continuum pairs: negative targets still route through setContinuum.
    if (to < 0 && this.config.continuumPairs) {
      const pairInfo = this.config.continuumPairs[numId];
      if (pairInfo) {
        const negAU = pairInfo.isNegative ? numId : pairInfo.pairId;
        const posAU = pairInfo.isNegative ? pairInfo.pairId : numId;
        const continuumValue = pairInfo.isNegative ? -to : to;
        return this.transitionContinuum(negAU, posAU, continuumValue, durationMs, balance);
      }
    }

    const target = clamp01(to);
    if (balance !== undefined) {
      this.auBalances[numId] = balance;
    }

    // Instant and timed transitions both drive Rust via setAU. No parallel
    // TypeScript morph/bone solvers remain on this path.
    if (durationMs <= 0) {
      this.setAU(numId, target, balance ?? this.auBalances[numId]);
      return { promise: Promise.resolve(), pause: () => {}, resume: () => {}, cancel: () => {} };
    }

    const from = this.auValues[numId] ?? 0;
    const storedBalance = balance ?? this.auBalances[numId];
    return this.animation.addTransition(
      `au_${numId}`,
      from,
      target,
      durationMs,
      (value) => this.setAU(numId, value, storedBalance)
    );
  }

  getAU(id: number): number {
    return this.auValues[id] ?? 0;
  }

  getCompositeRotations(): CompositeRotation[] {
    return this.compositeRotations;
  }

  // ============================================================================
  // CONTINUUM CONTROL (for paired AUs like eyes left/right, head up/down)
  // ============================================================================

  /**
   * Set a continuum AU pair immediately (no animation).
   *
   * Sign convention:
   * - Negative value (-1 to 0): activates negAU (e.g., head left, eyes left)
   * - Positive value (0 to +1): activates posAU (e.g., head right, eyes right)
   *
   * @param negAU - AU ID for negative direction (e.g., 61 for eyes left)
   * @param posAU - AU ID for positive direction (e.g., 62 for eyes right)
   * @param continuumValue - Value from -1 (full negative) to +1 (full positive)
   * @param balance - Optional L/R balance for bilateral morphs
   */
  setContinuum(negAU: number, posAU: number, continuumValue: number, balance?: number): void {
    const value = Math.max(-1, Math.min(1, continuumValue));

    if (value < 0) {
      this.setAU(posAU, 0, balance);
      this.setAU(negAU, Math.abs(value), balance);
      return;
    }
    if (value > 0) {
      this.setAU(negAU, 0, balance);
      this.setAU(posAU, value, balance);
      return;
    }

    this.setAU(negAU, 0, balance);
    this.setAU(posAU, 0, balance);
  }

  /**
   * Smoothly transition a continuum AU pair (e.g., eyes left/right, head up/down).
   * Takes a continuum value from -1 to +1 and internally manages both AU values.
   *
   * @param negAU - AU ID for negative direction (e.g., 61 for eyes left)
   * @param posAU - AU ID for positive direction (e.g., 62 for eyes right)
   * @param continuumValue - Target value from -1 (full negative) to +1 (full positive)
   * @param durationMs - Transition duration in milliseconds
   * @param balance - Optional L/R balance for bilateral morphs
   */
  transitionContinuum(negAU: number, posAU: number, continuumValue: number, durationMs = 200, balance?: number): TransitionHandle {
    const target = Math.max(-1, Math.min(1, continuumValue));
    const driverKey = `continuum_${negAU}_${posAU}`;

    // Get current continuum value: positive if posAU active, negative if negAU active
    const currentNeg = this.auValues[negAU] ?? 0;
    const currentPos = this.auValues[posAU] ?? 0;
    const currentContinuum = currentPos - currentNeg;

    return this.animation.addTransition(driverKey, currentContinuum, target, durationMs, (value) => this.setContinuum(negAU, posAU, value, balance));
  }

  // ============================================================================
  // MORPH CONTROL
  // ============================================================================

  addMorphTarget(target: MorphTargetDelta, options: AddMorphTargetOptions = {}): number {
    this.validateMorphTargetDelta(target, options);
    const staleMorphTargets = this.collectResolvedExpressionMorphTargets();
    const index = this.applyMorphTargetDelta(target, options);
    this.refreshMorphTargets([target.meshName]);
    this.reinitializeRuntimeStateFromCurrentControls(staleMorphTargets);
    return index;
  }

  addMorphTargets(targets: MorphTargetDelta[], options: AddMorphTargetOptions = {}): Record<string, number> {
    if (targets.length === 0) return {};

    const batchKeys = new Set<string>();
    const batchRelativeModeByMesh = new Map<string, boolean>();
    for (const target of targets) {
      const key = `${target.meshName}:${target.name}`;
      if (batchKeys.has(key)) {
        throw new Error(`Morph target "${target.name}" for mesh "${target.meshName}" appears more than once in the same batch.`);
      }
      batchKeys.add(key);
      this.validateMorphTargetDelta(target, options);
      const targetIsRelative = target.relative !== false;
      const batchRelativeMode = batchRelativeModeByMesh.get(target.meshName);
      if (batchRelativeMode !== undefined && batchRelativeMode !== targetIsRelative) {
        throw new Error(`Cannot mix relative and absolute morph targets for mesh "${target.meshName}" in the same batch.`);
      }
      batchRelativeModeByMesh.set(target.meshName, targetIsRelative);
    }

    const staleMorphTargets = this.collectResolvedExpressionMorphTargets();
    const result: Record<string, number> = {};
    const touchedMeshes = new Set<string>();

    try {
      for (const target of targets) {
        const index = this.applyMorphTargetDelta(target, options);
        touchedMeshes.add(target.meshName);
        result[`${target.meshName}:${target.name}`] = index;
      }
    } finally {
      if (touchedMeshes.size > 0) {
        this.refreshMorphTargets(Array.from(touchedMeshes));
        this.reinitializeRuntimeStateFromCurrentControls(staleMorphTargets);
      }
    }

    return result;
  }

  ensureMorphInfluence(meshName: string, morphName: string): number {
    const mesh = this.requireNamedMesh(meshName);
    const dict = this.getMeshMorphDictionary(mesh);
    const existing = dict[morphName];
    if (existing !== undefined) return existing;

    const position = mesh.geometry.getAttribute('position');
    if (!position) {
      throw new Error(`Cannot create morph target "${morphName}" on mesh "${meshName}": geometry has no position attribute.`);
    }

    return this.addMorphTarget({
      meshName,
      name: morphName,
      position: new Float32Array(position.count * position.itemSize),
      relative: true,
    });
  }

  refreshMorphTargets(_meshNames?: string[]): void {
    this.morphKeyCache.clear();
    this.morphIndexCache.clear();

    if (this.model) {
      this.meshByName.clear();
      this.model.traverse((obj: any) => {
        if (obj.isMesh && obj.name) {
          this.meshByName.set(obj.name, obj);
        }
      });
      this.meshes = collectMorphMeshes(this.model);
    }

    this.rebuildMorphTargetsCache();
    this.refreshHostNeutralModelDescriptor();
    this.hairPhysics.refreshMeshSelection();
  }

  /**
   * Set a morph target value.
   *
   * Fast paths (in order of speed):
   * 1. Pass pre-resolved { infl, idx } array directly - zero lookups
   * 2. String key with cache hit - one Map lookup
   * 3. String key cache miss - dictionary lookup, then cached for next time
   */
  setMorph(key: string, v: number, meshNames?: string[]): void;
  setMorph(key: string, v: number, targets: { infl: number[]; idx: number }[]): void;
  setMorph(
    key: string,
    v: number,
    meshNamesOrTargets?: string[] | { infl: number[]; idx: number }[]
  ): void {
    const val = clamp01(v);

    // Fast path: pre-resolved targets array (from transitionMorph)
    if (Array.isArray(meshNamesOrTargets) && meshNamesOrTargets.length > 0 && typeof meshNamesOrTargets[0] === 'object' && 'infl' in meshNamesOrTargets[0]) {
      const targets = meshNamesOrTargets as { infl: number[]; idx: number }[];
      this.applyMorphTargets(targets, val);
      return;
    }

    const meshNames = meshNamesOrTargets as string[] | undefined;
    const targets = this.resolveMorphTargets(key, meshNames);
    if (targets.length === 0) return;
    this.applyMorphTargets(targets, val);
  }

  setMorphInfluence(index: number, v: number, meshNames?: string[]): void {
    const val = clamp01(v);
    const targets = this.resolveMorphTargetsByIndex(index, meshNames);
    if (targets.length === 0) return;
    this.applyMorphTargets(targets, val);
  }

  /**
   * Resolve morph key to direct targets for ultra-fast repeated access.
   * Use this when you need to set the same morph many times (e.g., in animation loops).
   */
  private resolveMorphTargetIndex(
    dict: Record<string, number> | undefined,
    key: string
  ): number | undefined {
    if (!dict) return undefined;

    const prefix = this.config.morphPrefix || '';
    const suffix = this.config.morphSuffix || '';
    const fullName = prefix + key + suffix;

    // Validation treats the configured full name as the source of truth, so runtime
    // mirrors that ordering and only accepts suffix-pattern variants after an exact hit.
    // We intentionally do not fall back to the bare key here because that would let a
    // prefixed profile appear valid at runtime while validation still reports a miss.
    const exactIndex = dict[fullName];
    if (exactIndex !== undefined) {
      return exactIndex;
    }

    const suffixRegex = this.config.suffixPattern
      ? new RegExp(this.config.suffixPattern)
      : null;
    if (!suffixRegex) {
      return undefined;
    }

    for (const [candidate, index] of Object.entries(dict)) {
      if (!candidate.startsWith(fullName)) continue;
      const candidateSuffix = candidate.slice(fullName.length);
      if (candidateSuffix === '' || suffixRegex.test(candidateSuffix)) {
        return index;
      }
    }

    return undefined;
  }

  resolveMorphTargets(key: string, meshNames?: string[]): { infl: number[]; idx: number }[] {
    // Cache key includes mesh names to avoid conflicts between face and hair morphs
    const targetMeshes = meshNames || this.config.morphToMesh?.face || [];
    const cacheKey = this.getMorphKeyCacheKey(key, meshNames);

    // Check cache first
    const cached = this.morphKeyCache.get(cacheKey);
    if (cached) return cached;

    // Resolve and cache
    const targets: { infl: number[]; idx: number }[] = [];

    for (const name of targetMeshes) {
      const mesh = this.meshByName.get(name);
      if (!mesh) continue;
      const dict = mesh.morphTargetDictionary;
      const infl = mesh.morphTargetInfluences;
      if (!dict || !infl) continue;
      const idx = this.resolveMorphTargetIndex(dict as Record<string, number>, key);
      if (idx !== undefined) {
        targets.push({ infl, idx });
      }
    }

    if (targets.length > 0) {
      this.morphKeyCache.set(cacheKey, targets);
    }
    return targets;
  }

  resolveMorphTargetsByIndex(index: number, meshNames?: string[]): { infl: number[]; idx: number }[] {
    const idx = Number.isInteger(index) && index >= 0 ? index : null;
    if (idx === null) return [];
    const targetMeshes = meshNames || this.config.morphToMesh?.face || [];
    const cacheKey = this.getMorphIndexCacheKey(idx, meshNames);

    const cached = this.morphIndexCache.get(cacheKey);
    if (cached) return cached;

    const targets: { infl: number[]; idx: number }[] = [];

    for (const name of targetMeshes) {
      const mesh = this.meshByName.get(name);
      if (!mesh) continue;
      const infl = mesh.morphTargetInfluences;
      if (!infl || idx >= infl.length) continue;
      targets.push({ infl, idx });
    }

    if (targets.length > 0) {
      this.morphIndexCache.set(cacheKey, targets);
    }
    return targets;
  }

  transitionMorph(key: string, to: number, durationMs = 120, meshNames?: string[]): TransitionHandle {
    const transitionKey = meshNames?.length
      ? `morph_${this.getMorphKeyCacheKey(key, meshNames)}`
      : `morph_${this.getMorphKeyCacheKey(key)}`;
    const target = clamp01(to);

    // Pre-resolve targets once, then use direct access during animation
    const targets = this.resolveMorphTargets(key, meshNames);

    // Get "from" value from the resolved targets (more accurate for hair meshes)
    const from = targets.length > 0 ? (targets[0].infl[targets[0].idx] ?? 0) : this.getMorphValue(key);

    return this.animation.addTransition(transitionKey, from, target, durationMs, (value) => {
      // Ultra-fast path: direct array access, no lookups
      const val = clamp01(value);
      this.applyMorphTargets(targets, val);
    });
  }

  transitionMorphInfluence(index: number, to: number, durationMs = 120, meshNames?: string[]): TransitionHandle {
    const transitionKey = meshNames?.length
      ? `morph_${this.getMorphIndexCacheKey(index, meshNames)}`
      : `morph_${this.getMorphIndexCacheKey(index)}`;
    const target = clamp01(to);

    const targets = this.resolveMorphTargetsByIndex(index, meshNames);
    const from = targets.length > 0 ? (targets[0].infl[targets[0].idx] ?? 0) : this.getMorphValueByIndex(index);

    return this.animation.addTransition(transitionKey, from, target, durationMs, (value) => {
      const val = clamp01(value);
      this.applyMorphTargets(targets, val);
    });
  }

  // ============================================================================
  // VISEME CONTROL
  // ============================================================================

  setViseme(visemeIndex: number, value: number, jawScale = 1.0): void {
    if (visemeIndex < 0 || visemeIndex >= this.visemeValues.length) return;

    const val = clamp01(value);
    this.visemeValues[visemeIndex] = val;
    this.visemeJawScales[visemeIndex] = jawScale;
    this.applyVisemeRuntimeState();
  }

  transitionViseme(visemeIndex: number, to: number, durationMs = 80, jawScale = 1.0): TransitionHandle {
    if (visemeIndex < 0 || visemeIndex >= this.visemeValues.length) {
      return { promise: Promise.resolve(), pause: () => {}, resume: () => {}, cancel: () => {} };
    }

    const target = clamp01(to);
    const from = this.visemeValues[visemeIndex] ?? 0;
    this.visemeJawScales[visemeIndex] = jawScale;

    return this.animation.addTransition(
      `viseme_value_${visemeIndex}`,
      from,
      target,
      durationMs,
      (value) => {
        this.visemeValues[visemeIndex] = clamp01(value);
        this.visemeJawScales[visemeIndex] = jawScale;
        this.applyVisemeRuntimeState();
      }
    );
  }

  setVisemeById(slotId: string, value: number, jawScale = 1.0): void {
    const index = getVisemeSlotIndex(this.config, slotId);
    if (index < 0) return;
    this.setViseme(index, value, jawScale);
  }

  transitionVisemeById(slotId: string, to: number, durationMs = 80, jawScale = 1.0): TransitionHandle {
    const index = getVisemeSlotIndex(this.config, slotId);
    if (index < 0) {
      return { promise: Promise.resolve(), pause: () => {}, resume: () => {}, cancel: () => {} };
    }
    return this.transitionViseme(index, to, durationMs, jawScale);
  }

  // ============================================================================
  // MIX WEIGHT CONTROL
  // ============================================================================

  setAUMixWeight(id: number, weight: number): void {
    this.mixWeights[id] = clamp01(weight);
    this.wasmRuntimeCore?.setAUMixWeight(id, weight);
    const v = this.auValues[id] ?? 0;
    if (v > 0) this.setAU(id, v);
  }

  getAUMixWeight(id: number): number {
    return this.mixWeights[id] ?? this.config.auMixDefaults?.[id] ?? 1.0;
  }

  /**
   * Check if an AU has bilateral bone bindings (left + right side hints).
   * Used to determine if a balance slider should be shown for bone-only bilateral AUs.
   */
  hasLeftRightBones(auId: number): boolean {
    const bindings = this.config.auToBones[auId] || [];
    const hasLeft = bindings.some((binding) => binding.side === 'left');
    const hasRight = bindings.some((binding) => binding.side === 'right');
    return hasLeft && hasRight;
  }

  // ============================================================================
  // PLAYBACK CONTROL
  // ============================================================================

  pause(): void { this.isPaused = true; }
  resume(): void { this.isPaused = false; }
  getPaused(): boolean { return this.isPaused; }
  clearTransitions(): void { this.animation.clearTransitions(); }
  getActiveTransitionCount(): number { return this.animation.getActiveTransitionCount(); }

  resetToNeutral(): void {
    this.auValues = {};
    this.auBalances = {};
    const visemeCount = getProfileVisemeSlots(this.config).length;
    this.visemeValues = new Array(visemeCount).fill(0);
    this.visemeJawScales = new Array(visemeCount).fill(1);
    this.clearTransitions();
    this.wasmRuntimeCore?.clear();
    this.applyLiveFrameDelta();
    this.syncHairFromHeadAus();
  }

  private reinitializeRuntimeStateFromCurrentControls(staleMorphTargets: MorphTargetHandle[] = []): void {
    this.clearTransitions();
    this.resetMorphTargetHandles(staleMorphTargets);
    this.resyncWasmFromLocalControls();
    this.applyVisemeRuntimeState();
    this.applyLiveFrameDelta();
    this.syncHairFromHeadAus();
    this.model?.updateMatrixWorld(true);
  }

  private resyncWasmFromLocalControls(): void {
    if (!this.wasmRuntimeCore) return;
    this.wasmRuntimeCore.clear();
    for (const [auIdText, value] of Object.entries(this.auValues)) {
      const auId = Number(auIdText);
      if (Number.isNaN(auId)) continue;
      this.wasmRuntimeCore.setAU(auId, value, this.auBalances[auId] ?? 0);
    }
    for (const [auIdText, weight] of Object.entries(this.mixWeights)) {
      const auId = Number(auIdText);
      if (Number.isNaN(auId)) continue;
      this.wasmRuntimeCore.setAUMixWeight(auId, weight);
    }
  }

  private reapplyProceduralStateAfterBakedUpdate(): void {
    if (!this.model) {
      return;
    }

    let hasActiveOverrides = false;

    for (const [auIdStr, value] of Object.entries(this.auValues)) {
      if (value <= 0) continue;
      const auId = Number(auIdStr);
      if (Number.isNaN(auId)) continue;
      hasActiveOverrides = true;
      this.setAU(auId, value, this.auBalances[auId]);
    }

    for (let visemeIndex = 0; visemeIndex < this.visemeValues.length; visemeIndex += 1) {
      const value = this.visemeValues[visemeIndex] ?? 0;
      if (value <= 0) continue;
      hasActiveOverrides = true;
      this.setViseme(visemeIndex, value, this.visemeJawScales[visemeIndex] ?? 1);
    }

    if (!hasActiveOverrides) {
      return;
    }

    this.applyLiveFrameDelta();
    this.syncHairFromHeadAus();
    this.model.updateMatrixWorld(true);
  }

  // ============================================================================
  // MESH CONTROL
  // ============================================================================

  getMeshList(): MeshInfo[] {
    if (!this.model) return [];
    const result: MeshInfo[] = [];
    this.model.traverse((obj: any) => {
      if (obj.isMesh) {
        const meshInfo = CC4_MESHES[obj.name];
        result.push({
          name: obj.name,
          visible: obj.visible,
          morphCount: obj.morphTargetInfluences?.length || 0,
          category: meshInfo?.category || 'other',
        });
      }
    });
    return result;
  }

  /** Get all morph targets grouped by mesh name */
  getMorphTargets(): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    for (const mesh of this.meshes) {
      const dict = mesh.morphTargetDictionary;
      if (dict) {
        result[mesh.name] = Object.keys(dict).sort();
      }
    }
    return result;
  }

  /** Get morph target indices mapped to labels for each mesh */
  getMorphTargetIndices(): Record<string, { index: number; name: string }[]> {
    const result: Record<string, { index: number; name: string }[]> = {};
    for (const mesh of this.meshes) {
      const dict = mesh.morphTargetDictionary;
      if (!dict) continue;

      const entries = Object.entries(dict).map(([name, index]) => ({
        name,
        index,
      }));

      entries.sort((a, b) => a.index - b.index);
      result[mesh.name] = entries;
    }
    return result;
  }

  /** Get all resolved bone names and their current transforms */
  getBones(): Record<string, { position: [number, number, number]; rotation: [number, number, number] }> {
    const result: Record<string, { position: [number, number, number]; rotation: [number, number, number] }> = {};
    for (const name of Object.keys(this.bones)) {
      const entry = this.bones[name];
      if (entry) {
        const pos = entry.obj.position;
        const rot = entry.obj.rotation;
        result[name] = {
          position: [pos.x, pos.y, pos.z],
          rotation: [rot.x * 180 / Math.PI, rot.y * 180 / Math.PI, rot.z * 180 / Math.PI],
        };
      }
    }
    return result;
  }

  setMeshVisible(meshName: string, visible: boolean): void {
    if (!this.model) return;
    this.frameApplier.setMeshVisible(this.model, meshName, visible);
  }

  /**
   * Highlight a mesh with an emissive glow effect
   * @param meshName - Name of the mesh to highlight (null to clear all highlights)
   * @param color - Highlight color (default: cyan 0x00ffff)
   * @param intensity - Emissive intensity (default: 0.5)
   */
  highlightMesh(meshName: string | null, color: number = 0x00ffff, intensity: number = 0.5): void {
    if (!this.model) return;
    this.frameApplier.highlightMesh(this.model, meshName, color, intensity);
  }

  /** Get material config for a mesh */
  getMeshMaterialConfig(meshName: string): ThreeResolvedMaterialConfig | null {
    if (!this.model) return null;
    return this.frameApplier.getMeshMaterialConfig(this.model, meshName);
  }

  /** Set material config for a mesh */
  setMeshMaterialConfig(meshName: string, config: ThreeMaterialConfig): void {
    if (!this.model) return;
    this.frameApplier.setMeshMaterialConfig(this.model, meshName, config);
  }

  // ============================================================================
  // CONFIGURATION
  // ============================================================================

  private applyHairPhysicsProfileConfig(): void {
    this.hairPhysics.setHairPhysicsProfileConfig(this.config.hairPhysics);
  }

  setProfile(profile: Profile): void {
    this.config = profile;
    this.compositeRotations = this.config.compositeRotations || [];
    this.mixWeights = { ...profile.auMixDefaults };
    this.syncVisemeRuntimeState();
    let staleMorphTargets: MorphTargetHandle[] = [];
    if (this.model) {
      staleMorphTargets = this.collectResolvedExpressionMorphTargets();
      // Clear live transforms before re-resolving so rest poses stay truthful.
      for (const entry of Object.values(this.bones)) {
        if (!entry) continue;
        entry.obj.position.set(entry.basePos.x, entry.basePos.y, entry.basePos.z);
        entry.obj.quaternion.copy(entry.baseQuat);
        entry.obj.rotation.setFromQuaternion(entry.obj.quaternion, entry.obj.rotation.order);
      }
      const inspection = this.modelInspector.inspectModel(this.model, {
        meshes: this.meshes,
        profile: this.config,
        previousBones: this.bones,
      });
      this.bones = inspection.bones;
      this.missingBoneWarnings.clear();
      this.rebuildMorphTargetsCache();
      this.wasmRuntimeCore?.setProfile(this.config);
      this.refreshHostNeutralModelDescriptor();
    }
    this.hairPhysics.refreshMeshSelection();
    this.applyHairPhysicsProfileConfig();
    this.reinitializeRuntimeStateFromCurrentControls(staleMorphTargets);
  }

  getProfile(): Profile { return this.config; }

  /**
   * Get the mesh names that should receive morph influences for a given AU.
   * Routing is driven by `auFacePartToMeshCategory` in profile config.
   */
  getMeshNamesForAU(auId: number): string[] {
    return getMeshNamesForAUProfile(this.config, auId);
  }

  getMeshNamesForViseme(): string[] {
    return getMeshNamesForVisemeProfile(this.config);
  }

  // ============================================================================
  // HAIR PHYSICS
  // ============================================================================

  registerHairObjects(objects: Object3D[]): Array<{ name: string; isMesh: boolean; isEyebrow: boolean }> {
    return this.hairPhysics.registerHairObjects(objects);
  }

  getRegisteredHairObjects(): Mesh[] {
    return this.hairPhysics.getRegisteredHairObjects();
  }

  setHairPhysicsEnabled(enabled: boolean): void {
    this.hairPhysics.setHairPhysicsEnabled(enabled);
    if (enabled) {
      const head = this.getHeadRotation();
      this.hairPhysics.onHeadRotationChanged(head.yaw, head.pitch);
    }
  }

  isHairPhysicsEnabled(): boolean {
    return this.hairPhysics.isHairPhysicsEnabled();
  }

  setHairPhysicsConfig(config: HairPhysicsConfigUpdate): void {
    this.hairPhysics.setHairPhysicsConfig(config);
  }

  getHairPhysicsConfig(): HairPhysicsConfig {
    return this.hairPhysics.getHairPhysicsConfig();
  }

  validateHairMorphTargets(): string[] {
    return this.hairPhysics.validateHairMorphTargets();
  }

  /** Head pose for hair physics, derived from head continuum AUs (-1..1). */
  getHeadRotation(): { yaw: number; pitch: number; roll: number } {
    const yaw = (this.auValues[52] ?? 0) - (this.auValues[51] ?? 0);
    const pitch = (this.auValues[53] ?? 0) - (this.auValues[54] ?? 0);
    const roll = (this.auValues[56] ?? 0) - (this.auValues[55] ?? 0);
    return { yaw, pitch, roll };
  }


  updateHairPhysics(dt: number): void {
    this.hairPhysics.update(dt);
  }

  getHairMorphTargets(meshName?: string): string[] {
    return this.hairPhysics.getHairMorphTargets(meshName);
  }

  setMorphOnMeshes(meshNames: string[], morphKey: string, value: number): void {
    this.hairPhysics.setMorphOnMeshes(meshNames, morphKey, value);
  }

  applyHairStateToObject(objectName: string, state: {
    color?: { baseColor: string; emissive: string; emissiveIntensity: number };
    outline?: { show: boolean; color: string; opacity: number };
    visible?: boolean;
    scale?: { x: number; y: number; z: number };
    position?: { x: number; y: number; z: number };
    isEyebrow?: boolean;
  }): void {
    this.hairPhysics.applyHairStateToObject(objectName, state);
  }

  getHairAppearance() {
    return this.hairPhysics.getHairAppearance();
  }

  setHairColor(color: Parameters<HairPhysicsController['setHairColor']>[0]): void {
    this.hairPhysics.setHairColor(color);
  }

  setEyebrowColor(color: Parameters<HairPhysicsController['setEyebrowColor']>[0]): void {
    this.hairPhysics.setEyebrowColor(color);
  }

  setHairBaseColor(baseColor: string): void {
    this.hairPhysics.setHairBaseColor(baseColor);
  }

  setEyebrowBaseColor(baseColor: string): void {
    this.hairPhysics.setEyebrowBaseColor(baseColor);
  }

  setHairGlow(emissive: string, intensity: number): void {
    this.hairPhysics.setHairGlow(emissive, intensity);
  }

  setEyebrowGlow(emissive: string, intensity: number): void {
    this.hairPhysics.setEyebrowGlow(emissive, intensity);
  }

  setHairOutline(outline: { show: boolean; color?: string; opacity?: number }): void {
    this.hairPhysics.setHairOutline(outline);
  }

  // ============================================================================
  // PRIVATE METHODS
  // ============================================================================

  private computeSideValues(base: number, balance?: number): { left: number; right: number } {
    const b = Math.max(-1, Math.min(1, balance ?? 0));
    if (b === 0) return { left: base, right: base };
    if (b < 0) return { left: base, right: base * (1 + b) };
    return { left: base * (1 - b), right: base };
  }

  private applyMorphTargets(targets: MorphTargetHandle[], val: number): void {
    this.frameApplier.applyMorphTargets(targets, val);
  }

  private applyVisemeRuntimeState(): void {
    if (!this.wasmRuntimeCore) {
      throw new Error(
        'Embody Rust/Wasm core is required before applying visemes. Await initEmbodyCore() or use Embody.create().'
      );
    }
    for (let index = 0; index < this.visemeValues.length; index += 1) {
      this.wasmRuntimeCore.setViseme(
        index,
        this.visemeValues[index] ?? 0,
        this.visemeJawScales[index] ?? 1
      );
    }
    this.applyLiveFrameDelta();
  }

  private getMorphValue(key: string): number {
    if (this.faceMesh) {
      const dict = this.faceMesh.morphTargetDictionary;
      const infl = this.faceMesh.morphTargetInfluences;
      if (dict && infl) {
        const idx = this.resolveMorphTargetIndex(dict as Record<string, number>, key);
        if (idx !== undefined) return infl[idx] ?? 0;
      }
      return 0;
    }
    for (const mesh of this.meshes) {
      const dict = mesh.morphTargetDictionary;
      const infl = mesh.morphTargetInfluences;
      if (!dict || !infl) continue;
      const idx = this.resolveMorphTargetIndex(dict as Record<string, number>, key);
      if (idx !== undefined) return infl[idx] ?? 0;
    }
    return 0;
  }

  private getMorphValueForMeshes(key: string, meshNames?: string[]): number {
    const targets = this.resolveMorphTargets(key, meshNames);
    if (targets.length > 0) {
      return targets[0].infl[targets[0].idx] ?? 0;
    }
    return this.getMorphValue(key);
  }

  private getMorphValueByIndex(index: number): number {
    const idx = Number.isInteger(index) && index >= 0 ? index : null;
    if (idx === null) return 0;
    if (this.faceMesh) {
      const infl = this.faceMesh.morphTargetInfluences;
      if (infl && idx < infl.length) {
        return infl[idx] ?? 0;
      }
      return 0;
    }
    for (const mesh of this.meshes) {
      const infl = mesh.morphTargetInfluences;
      if (!infl) continue;
      if (idx < infl.length) return infl[idx] ?? 0;
    }
    return 0;
  }

  private getMorphValueByIndexForMeshes(index: number, meshNames?: string[]): number {
    const targets = this.resolveMorphTargetsByIndex(index, meshNames);
    if (targets.length > 0) {
      return targets[0].infl[targets[0].idx] ?? 0;
    }
    return this.getMorphValueByIndex(index);
  }

  private validateMorphTargetDelta(target: MorphTargetDelta, options: AddMorphTargetOptions): void {
    const mesh = this.requireNamedMesh(target.meshName);
    const geometry = mesh.geometry;
    const position = geometry.getAttribute('position');
    if (!position) {
      throw new Error(`Cannot add morph target "${target.name}" to mesh "${target.meshName}": geometry has no position attribute.`);
    }
    if (!target.name || !target.name.trim()) {
      throw new Error(`Cannot add morph target to mesh "${target.meshName}": target name is required.`);
    }

    const existingIndex = this.getMeshMorphDictionary(mesh)[target.name];
    if (existingIndex !== undefined && options.replace !== true) {
      throw new Error(`Morph target "${target.name}" already exists on mesh "${target.meshName}". Pass replace: true to overwrite it.`);
    }

    this.assertMorphAttributeDataLength(target.name, 'position', target.position, position.itemSize, position.count);
    const normal = geometry.getAttribute('normal');
    if (target.normal) {
      this.assertMorphAttributeDataLength(target.name, 'normal', target.normal, normal?.itemSize ?? 3, position.count);
    }
    const tangent = geometry.getAttribute('tangent');
    if (target.tangent) {
      this.assertMorphAttributeDataLength(target.name, 'tangent', target.tangent, tangent?.itemSize ?? 4, position.count);
    }
    this.assertCompatibleMorphTargetMode(geometry, target);
  }

  private applyMorphTargetDelta(target: MorphTargetDelta, options: AddMorphTargetOptions): number {
    const mesh = this.requireNamedMesh(target.meshName);
    const sourceGeometry = mesh.geometry;
    const position = sourceGeometry.getAttribute('position');
    if (!position) {
      throw new Error(`Cannot add morph target "${target.name}" to mesh "${target.meshName}": geometry has no position attribute.`);
    }
    if (!target.name || !target.name.trim()) {
      throw new Error(`Cannot add morph target to mesh "${target.meshName}": target name is required.`);
    }

    const replace = options.replace === true;
    const resetInfluence = options.resetInfluence !== false;
    const forceGeometryReplacement = options.forceGeometryReplacement !== false;
    const previousInfluences = mesh.morphTargetInfluences ? [...mesh.morphTargetInfluences] : [];
    const previousDictionary = this.getMeshMorphDictionary(mesh);
    const existingIndex = previousDictionary[target.name];

    if (existingIndex !== undefined && !replace) {
      throw new Error(`Morph target "${target.name}" already exists on mesh "${target.meshName}". Pass replace: true to overwrite it.`);
    }
    this.assertCompatibleMorphTargetMode(sourceGeometry, target);

    const geometry = forceGeometryReplacement ? sourceGeometry.clone() : sourceGeometry;
    const dictionary = { ...previousDictionary };
    const usedIndices = Object.values(dictionary).filter(Number.isInteger);
    const existingAttributeTargetCount = Math.max(
      0,
      ...Object.values(geometry.morphAttributes).map((attributes) => attributes?.length ?? 0)
    );
    const nextIndex = Math.max(existingAttributeTargetCount, usedIndices.length ? Math.max(...usedIndices) + 1 : 0);
    const index = existingIndex ?? nextIndex;
    dictionary[target.name] = index;

    this.setMorphAttributeAtIndex(geometry, 'position', target.position, position.itemSize, position.count, index, target.name);

    const normal = geometry.getAttribute('normal');
    if (target.normal) {
      this.setMorphAttributeAtIndex(geometry, 'normal', target.normal, normal?.itemSize ?? 3, position.count, index, target.name);
    } else {
      this.setZeroMorphAttributeAtIndex(geometry, 'normal', normal?.itemSize ?? 3, position.count, index, target.name);
    }

    const tangent = geometry.getAttribute('tangent');
    if (target.tangent) {
      this.setMorphAttributeAtIndex(geometry, 'tangent', target.tangent, tangent?.itemSize ?? 4, position.count, index, target.name);
    } else {
      this.setZeroMorphAttributeAtIndex(geometry, 'tangent', tangent?.itemSize ?? 4, position.count, index, target.name);
    }
    const color = geometry.getAttribute('color');
    const existingColorMorph = geometry.morphAttributes.color?.find(Boolean);
    this.setZeroMorphAttributeAtIndex(
      geometry,
      'color',
      color?.itemSize ?? existingColorMorph?.itemSize ?? 3,
      position.count,
      index,
      target.name
    );

    geometry.morphTargetsRelative = target.relative !== false;
    (geometry as any).morphTargetDictionary = dictionary;

    if (forceGeometryReplacement) {
      mesh.geometry = geometry;
      sourceGeometry.dispose();
    }

    const influenceLength = Math.max(previousInfluences.length, index + 1);
    const influences = previousInfluences.slice(0, influenceLength);
    while (influences.length < influenceLength) {
      influences.push(0);
    }
    if (resetInfluence) {
      influences[index] = 0;
    }

    mesh.morphTargetDictionary = dictionary;
    mesh.morphTargetInfluences = influences;
    this.addRuntimeMorphMesh(mesh);

    if (!this.config.morphToMesh?.face?.length) {
      this.config.morphToMesh = {
        ...this.config.morphToMesh,
        face: [mesh.name],
      };
    }

    return index;
  }

  private requireNamedMesh(meshName: string): Mesh {
    const mesh = this.meshByName.get(meshName);
    if (mesh) return mesh;

    if (this.model) {
      let found: Mesh | null = null;
      this.model.traverse((obj: any) => {
        if (!found && obj.isMesh && obj.name === meshName) {
          found = obj as Mesh;
        }
      });
      if (found) {
        this.meshByName.set(meshName, found);
        return found;
      }
    }

    throw new Error(`Mesh "${meshName}" was not found in the current model.`);
  }

  private getMeshMorphDictionary(mesh: Mesh): Record<string, number> {
    const meshDictionary = mesh.morphTargetDictionary as Record<string, number> | undefined;
    const geometryDictionary = (mesh.geometry as any).morphTargetDictionary as Record<string, number> | undefined;
    const dictionary = meshDictionary || geometryDictionary || {};
    mesh.morphTargetDictionary = dictionary;
    (mesh.geometry as any).morphTargetDictionary = dictionary;
    return dictionary;
  }

  private assertMorphAttributeDataLength(
    name: string,
    semantic: string,
    data: Float32Array | number[],
    itemSize: number,
    vertexCount: number
  ): void {
    const expectedLength = vertexCount * itemSize;
    if (data.length !== expectedLength) {
      throw new Error(
        `Morph target "${name}" ${semantic} data has ${data.length} values; expected ${expectedLength} ` +
        `(${vertexCount} vertices * itemSize ${itemSize}).`
      );
    }
  }

  private assertCompatibleMorphTargetMode(geometry: Mesh['geometry'], target: MorphTargetDelta): void {
    const hasExistingMorphTargets = Object.values(geometry.morphAttributes).some((attributes) => (attributes?.length ?? 0) > 0);
    if (!hasExistingMorphTargets) return;

    const targetIsRelative = target.relative !== false;
    if (geometry.morphTargetsRelative !== targetIsRelative) {
      const existingMode = geometry.morphTargetsRelative ? 'relative' : 'absolute';
      const targetMode = targetIsRelative ? 'relative' : 'absolute';
      throw new Error(
        `Cannot add ${targetMode} morph target "${target.name}" to mesh "${target.meshName}" because existing morph targets are ${existingMode}.`
      );
    }
  }

  private setMorphAttributeAtIndex(
    geometry: Mesh['geometry'],
    semantic: string,
    data: Float32Array | number[],
    itemSize: number,
    vertexCount: number,
    index: number,
    name: string
  ): void {
    this.assertMorphAttributeDataLength(name, semantic, data, itemSize, vertexCount);

    const expectedLength = vertexCount * itemSize;
    const attributes = geometry.morphAttributes[semantic] ? [...geometry.morphAttributes[semantic]] : [];
    while (attributes.length < index) {
      const empty = new BufferAttribute(new Float32Array(expectedLength), itemSize);
      (empty as any).name = `morph_${attributes.length}`;
      attributes.push(empty);
    }

    const values = data instanceof Float32Array ? new Float32Array(data) : Float32Array.from(data);
    const attribute = new BufferAttribute(values, itemSize);
    (attribute as any).name = name;
    attributes[index] = attribute;
    geometry.morphAttributes[semantic] = attributes;
  }

  private setZeroMorphAttributeAtIndex(
    geometry: Mesh['geometry'],
    semantic: string,
    itemSize: number,
    vertexCount: number,
    index: number,
    name: string
  ): void {
    if (!geometry.morphAttributes[semantic]?.length) return;

    const expectedLength = vertexCount * itemSize;
    const attributes = [...geometry.morphAttributes[semantic]];
    while (attributes.length < index) {
      const empty = new BufferAttribute(new Float32Array(expectedLength), itemSize);
      (empty as any).name = `morph_${attributes.length}`;
      attributes.push(empty);
    }

    const empty = new BufferAttribute(new Float32Array(expectedLength), itemSize);
    (empty as any).name = name;
    attributes[index] = empty;
    geometry.morphAttributes[semantic] = attributes;
  }

  private addRuntimeMorphMesh(mesh: Mesh): void {
    const key = mesh.name || (mesh as any).uuid;
    const exists = this.meshes.some((candidate) => (candidate.name || (candidate as any).uuid) === key);
    if (!exists) {
      this.meshes.push(mesh);
    }
  }

  private getMorphKeyCacheKey(key: string, meshNames?: string[]): string {
    return meshNames?.length ? `key:${key}@${meshNames.join(',')}` : `key:${key}`;
  }

  private getMorphIndexCacheKey(index: number, meshNames?: string[]): string {
    return meshNames?.length ? `idx:${index}@${meshNames.join(',')}` : `idx:${index}`;
  }

  private syncVisemeRuntimeState(): void {
    const visemeCount = getProfileVisemeSlots(this.config).length;
    this.visemeValues = Array.from(
      { length: visemeCount },
      (_, index) => this.visemeValues[index] ?? 0
    );
    this.visemeJawScales = Array.from(
      { length: visemeCount },
      (_, index) => this.visemeJawScales[index] ?? 1
    );
  }

  private getVisemeJawAmount(visemeIndex: number): number {
    return getVisemeJawAmounts(this.config)?.[visemeIndex]
      ?? this.config.visemeJawAmounts?.[visemeIndex]
      ?? Embody.VISEME_JAW_AMOUNTS[visemeIndex]
      ?? 0;
  }

  private collectResolvedExpressionMorphTargets(): MorphTargetHandle[] {
    const targets: MorphTargetHandle[] = [];

    for (const resolved of this.resolvedAUMorphTargets.values()) {
      targets.push(...resolved.left, ...resolved.right, ...resolved.center);
    }

    for (const resolved of this.resolvedVisemeTargets) {
      if (resolved?.length) {
        targets.push(...resolved);
      }
    }

    return targets;
  }

  private resetMorphTargetHandles(targets: MorphTargetHandle[]): void {
    this.frameApplier.resetMorphTargets(targets);
  }

  private isMixedAU(id: number): boolean {
    const morphs = this.config.auToMorphs[id];
    const hasMorphs = !!(morphs?.left?.length || morphs?.right?.length || morphs?.center?.length);
    return !!(hasMorphs && this.config.auToBones[id]?.length);
  }

  private syncHairFromHeadAus(): void {
    if (!this.hairPhysics.isHairPhysicsEnabled()) return;
    const head = this.getHeadRotation();
    this.hairPhysics.onHeadRotationChanged(head.yaw, head.pitch);
  }

  /**
   * Apply render order and material settings from CC4_MESHES to all meshes.
   * This ensures proper layering (e.g., hair renders on top of eyebrows).
   * Also auto-registers hair and eyebrow meshes for hair physics.
   */
  private applyMeshMaterialSettings(root: Object3D): void {
    // Clear and rebuild hair object registry
    this.hairPhysics.clearRegisteredHairObjects();

    root.traverse((obj: any) => {
      if (!obj.isMesh || !obj.name) return;

      // Merge config.meshes (user overrides) with CC4_MESHES (preset defaults).
      // User overrides may only contain material settings, so always merge with
      // the preset to preserve category and other fields needed for registration.
      const configMesh = this.config.meshes?.[obj.name];
      const presetMesh = CC4_MESHES[obj.name];
      const meshInfo = configMesh && presetMesh ? { ...presetMesh, ...configMesh } : configMesh ?? presetMesh;
      const category = meshInfo?.category;

      // Auto-register hair and eyebrow meshes for hair physics
      if (category === 'hair' || category === 'eyebrow') {
        this.hairPhysics.autoRegisterHairMesh(obj as Mesh, category);
      }

      if (!meshInfo?.material) return;

      this.frameApplier.setMeshMaterialConfig(root, obj.name, meshInfo.material as ThreeMaterialConfig);
    });

  }

  // ============================================================================
  // MIXER / CLIP CONTROL
  // ============================================================================

  loadAnimationClips(clips: unknown[]): void {
    this.animationController.loadAnimationClips(clips);
  }

  getAnimationClips(): AnimationClipInfo[] {
    return this.animationController.getAnimationClips();
  }

  removeAnimationClip(clipName: string): boolean {
    return this.animationController.removeAnimationClip(clipName);
  }

  playAnimation(clipName: string, options: AnimationPlayOptions = {}): AnimationActionHandle | null {
    return this.animationController.playAnimation(clipName, options);
  }

  stopAnimation(clipName: string): void {
    this.animationController.stopAnimation(clipName);
  }

  stopAllAnimations(): void {
    this.animationController.stopAllAnimations();
  }

  pauseAnimation(clipName: string): void {
    this.animationController.pauseAnimation(clipName);
  }

  resumeAnimation(clipName: string): void {
    this.animationController.resumeAnimation(clipName);
  }

  pauseAllAnimations(): void {
    this.animationController.pauseAllAnimations();
  }

  resumeAllAnimations(): void {
    this.animationController.resumeAllAnimations();
  }

  setAnimationSpeed(clipName: string, speed: number): void {
    this.animationController.setAnimationSpeed(clipName, speed);
  }

  setAnimationIntensity(clipName: string, intensity: number): void {
    this.animationController.setAnimationIntensity(clipName, intensity);
  }

  setAnimationLoopMode(clipName: string, loopMode: 'repeat' | 'once' | 'pingpong'): void {
    this.animationController.setAnimationLoopMode(clipName, loopMode);
  }

  setAnimationRepeatCount(clipName: string, repeatCount?: number): void {
    this.animationController.setAnimationRepeatCount(clipName, repeatCount);
  }

  setAnimationReverse(clipName: string, reverse: boolean): void {
    this.animationController.setAnimationReverse(clipName, reverse);
  }

  setAnimationBlendMode(clipName: string, blendMode: AnimationBlendMode): void {
    this.animationController.setAnimationBlendMode(clipName, blendMode);
  }

  seekAnimation(clipName: string, time: number): void {
    this.animationController.seekAnimation(clipName, time);
  }

  setAnimationTimeScale(timeScale: number): void {
    this.animationController.setAnimationTimeScale(timeScale);
  }

  getAnimationState(clipName: string): AnimationState | null {
    return this.animationController.getAnimationState(clipName);
  }

  getPlayingAnimations(): AnimationState[] {
    return this.animationController.getPlayingAnimations();
  }

  crossfadeTo(clipName: string, duration = 0.3, options: AnimationPlayOptions = {}): AnimationActionHandle | null {
    return this.animationController.crossfadeTo(clipName, duration, options);
  }

  snippetToClip(
    clipName: string,
    curves: CurvesMap,
    options?: ClipOptions
  ): AnimationClip | null {
    return this.animationController.snippetToClip(clipName, curves, options);
  }

  playClip(clip: AnimationClip, options?: ClipOptions): ClipHandle | null {
    return this.animationController.playClip(clip, options);
  }

  playSnippet(
    snippet: Snippet | { name: string; curves: CurvesMap } | TypedSnippet | { name: string; channels: SnippetChannel[] },
    options?: ClipOptions
  ): ClipHandle | null {
    return this.animationController.playSnippet(snippet, options);
  }

  playTypedSnippet(
    snippet: TypedSnippet | { name: string; channels: SnippetChannel[] },
    options?: ClipOptions
  ): ClipHandle | null {
    return this.animationController.playTypedSnippet(snippet, options);
  }

  buildClip(
    clipName: string,
    curves: CurvesMap,
    options?: ClipOptions
  ): ClipHandle | null {
    return this.animationController.buildClip(clipName, curves, options);
  }

  buildTypedClip(
    clipName: string,
    channels: SnippetChannel[],
    options?: ClipOptions
  ): ClipHandle | null {
    return this.animationController.buildTypedClip(clipName, channels, options);
  }

  typedSnippetToClip(
    clipName: string,
    channels: SnippetChannel[],
    options?: ClipOptions
  ): AnimationClip | null {
    return this.animationController.typedSnippetToClip(clipName, channels, options);
  }

  cleanupSnippet(name: string) {
    this.animationController.cleanupSnippet(name);
  }

  updateClipParams(
    name: string,
    params: { weight?: number; rate?: number; loop?: boolean; loopMode?: 'once' | 'repeat' | 'pingpong'; repeatCount?: number; reverse?: boolean; actionId?: string }
  ): boolean {
    return this.animationController.updateClipParams(name, params);
  }

  /**
   * Check if curves can be played through buildClip.
   * Returns false if curves contain data that cannot be converted to mixer tracks.
   */
  supportsClipCurves(
    curves: Record<string, Array<{ time: number; intensity: number; inherit?: boolean }>>
  ): boolean {
    // Currently all curve-based playback is supported - bone AUs are handled via
    // quaternion tracks in the generated clip
    return Object.keys(curves).length > 0;
  }
}

/**
 * Helper function to collect meshes with morph targets from a scene.
 */
export function collectMorphMeshes(root: Object3D): Mesh[] {
  const meshes: Mesh[] = [];
  root.traverse((obj: any) => {
    if (obj.isMesh) {
      const dict = obj.morphTargetDictionary;
      const infl = obj.morphTargetInfluences;
      if ((dict && Object.keys(dict).length > 0) || (Array.isArray(infl) && infl.length > 0)) {
        meshes.push(obj);
      }
    }
  });
  return meshes;
}

export function buildFrameApplierBindings(
  inspection: ReturnType<ThreeModelInspector['inspectModel']>
): ThreeFrameApplierBindings {
  const meshes = new Map<import('../../core/contracts').MeshId, Mesh>();
  for (const meshDesc of inspection.descriptor.meshes) {
    const mesh = inspection.meshByName.get(meshDesc.name)
      || inspection.allMeshes.find((candidate) => candidate.name === meshDesc.name);
    if (mesh) {
      meshes.set(meshDesc.id, mesh);
    }
  }

  const morphTargets = new Map<
    import('../../core/contracts').MorphTargetId,
    { meshId: import('../../core/contracts').MeshId; mesh: Mesh; index: number }
  >();
  for (const morph of inspection.descriptor.morphTargets) {
    const mesh = meshes.get(morph.meshId);
    if (!mesh || morph.hostIndex === undefined) continue;
    morphTargets.set(morph.id, {
      meshId: morph.meshId,
      mesh,
      index: morph.hostIndex,
    });
  }

  const bonesByName = new Map<string, Object3D>();
  for (const entry of Object.values(inspection.bones)) {
    if (entry?.obj?.name) {
      bonesByName.set(entry.obj.name, entry.obj);
    }
  }
  if (inspection.allMeshes[0]?.parent) {
    let root: Object3D | null = inspection.allMeshes[0];
    while (root?.parent) root = root.parent;
    root?.traverse((obj) => {
      if (obj.name && !bonesByName.has(obj.name)) {
        bonesByName.set(obj.name, obj);
      }
    });
  }

  const bones = new Map<import('../../core/contracts').BoneId, Object3D>();
  for (const boneDesc of inspection.descriptor.bones) {
    const bone = bonesByName.get(boneDesc.name);
    if (bone) {
      bones.set(boneDesc.id, bone);
    }
  }

  return { meshes, morphTargets, bones };
}
