import {
  AdditiveAnimationBlendMode, AnimationClip, AnimationUtils, LoopOnce, LoopPingPong,
  NormalAnimationBlendMode, PropertyBinding, Quaternion, Euler, InterpolateDiscrete, InterpolateLinear,
} from 'three';
import type { KeyframeTrack, Mesh, Object3D } from 'three';
import type { AUDescriptor } from '@lovelace_lol/embody/wasm';
import { initEmbodyCore, requireInitializedEmbodyCore, DEFAULT_HAIR_COLOR_APPEARANCE } from '@lovelace_lol/embody/wasm';
import type { RuntimeCore } from '@lovelace_lol/embody/wasm';
import {
  ThreeFrameApplier, ThreeModelInspector, createAnimationClipFromClipIR,
  serializeAnimationClips,
} from './index';
import type { ClipIR, ClipIRTrack, ThreeModelInspection } from './index';
import {
  bindModelReferencePose, captureModelReferencePose, extendModelReferencePose,
} from './reference-pose';
import type { ThreeModelReferencePose, ThreeReferencePoseNode } from './reference-pose';
import { ThreeNativePlaybackConnector } from './nativePlayback';
import { withComponentTracks } from './clipBindings';
import { prepareDistanceTiming, validateDistancePredecessor, validateDistanceTiming } from './inheritedDistanceTiming';
import type { ContinuumPairs, DistancePredecessor, DistanceTimingOptions, InheritedDistanceBasis } from './inheritedDistanceTiming';
export type { DistanceTimingOptions } from './inheritedDistanceTiming';
import type { ThreeNativePlaybackControl, ThreeNativePlaybackEvent, ThreeNativePlaybackOptions } from './nativePlayback';

type JsonObject = Record<string, any>;
type NativeTrack = KeyframeTrack & { createInterpolant: ((result?: Float32Array) => { evaluate(time: number): ArrayLike<number> }) & { isInterpolantFactoryMethodGLTFCubicSpline?: boolean } };
export type RustEmbodyHostConfig = {
  profileMode?: 'preset' | 'profile';
  presetId?: string;
  presetType?: string;
  profile?: JsonObject;
  meshes?: Mesh[];
  referencePose?: ThreeModelReferencePose;
};
export type CharacterPlaybackOptions = JsonObject & { distanceTiming?: DistanceTimingOptions };
export type CharacterPlaybackEvent = ThreeNativePlaybackEvent & { actionId: string; clipName: string };
export interface CharacterPlaybackHandle {
  readonly name: string;
  actionId?: string;
  promise: Promise<CharacterPlaybackEvent>;
  readonly finished: Promise<CharacterPlaybackEvent>;
  play(): CharacterPlaybackHandle;
  stop(): CharacterPlaybackHandle;
  cancel(): CharacterPlaybackHandle;
  pause(): CharacterPlaybackHandle;
  resume(): CharacterPlaybackHandle;
  setWeight(value: number): CharacterPlaybackHandle;
  setIntensity(value: number): CharacterPlaybackHandle;
  setSpeed(value: number): CharacterPlaybackHandle;
  setPlaybackRate(value: number): CharacterPlaybackHandle;
  setTime(value: number): CharacterPlaybackHandle;
  seek(value: number): CharacterPlaybackHandle;
  updateParams(value: CharacterPlaybackOptions): CharacterPlaybackHandle;
  setParams(value: CharacterPlaybackOptions): CharacterPlaybackHandle;
  subscribe(listener: ((event: CharacterPlaybackEvent) => void) | { next(event: CharacterPlaybackEvent): void }): () => void;
}
export interface CharacterTransitionHandle {
  promise: Promise<void>;
  pause(): void;
  resume(): void;
  cancel(): void;
}

type Source =
  | { name: string; kind: 'native'; clip: AnimationClip }
  | { name: string; kind: 'curves' | 'typed'; input: any; options: CharacterPlaybackOptions }
  | { name: string; kind: 'compiled'; clip: ClipIR };
type Playback = {
  id: string;
  source: Source;
  options: CharacterPlaybackOptions;
  connector: ThreeNativePlaybackConnector;
  terminal: boolean;
  inheritedStarts: Map<string, number[]>;
  distanceBasis?: InheritedDistanceBasis;
  replay(options: CharacterPlaybackOptions): CharacterPlaybackHandle;
  notify(event: CharacterPlaybackEvent): void;
};
const json = (value: unknown): string => JSON.stringify(value ?? {});
const targetKey = (target: ClipIRTrack['target']): string => JSON.stringify([target.kind, target.meshId, target.morphTargetId, target.boneId, target.objectId, target.property]);
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const parse = <T = any>(value: string): T => JSON.parse(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const intensity = (options: CharacterPlaybackOptions, fallback = 1): number => {
  const value = options.intensityScale ?? options.intensity ?? options.weight;
  return finite(value) ? Math.max(0, Math.min(2, value)) : fallback;
};
const presetId = (value?: string): string => value?.trim().toLowerCase() || 'cc4';

export function supportsRustEmbodyPreset(value?: string): boolean {
  return requireInitializedEmbodyCore().has_preset(presetId(value));
}

/** Character commands compile in Rust and play exclusively on the native connector. */
export class Embody {
  /** Ordinary AU snippet admission capability; not a second playback API. */
  readonly animationCapabilities = Object.freeze({ distanceTiming: true as const });
  readonly meshes: Mesh[] = [];
  meshByName = new Map<string, Mesh>();
  bones: ThreeModelInspection['bones'] = {};
  private readonly wasm = requireInitializedEmbodyCore();
  private core: RuntimeCore;
  private readonly inspector = new ThreeModelInspector();
  private readonly applier = new ThreeFrameApplier();
  private readonly references = new WeakMap<Object3D, ThreeModelReferencePose>();
  private referenceBindings: ReadonlyMap<Object3D, ThreeReferencePoseNode> = new Map();
  private boundModel?: Object3D;
  get model(): Object3D | undefined { return this.boundModel; }
  private inspection?: ThreeModelInspection;
  private connector?: ThreeNativePlaybackConnector;
  private profile: JsonObject;
  private profileSource: JsonObject;
  private readonly profileMode: 'preset' | 'profile';
  private readonly preset: string;
  private readonly sources = new Map<string, Source>();
  private readonly playbacks = new Map<string, Playback>();
  private readonly current = new Map<string, Playback>();
  private playDepth = 0;
  private readonly pendingEvents: ThreeNativePlaybackEvent[] = [];
  private bindingGeneration = 0;
  private continuumPairCache?: { core: unknown; pairs: ContinuumPairs };
  private disposed = false;
  private rendering = true;
  private timeScale = 1;
  private nextLiveTarget = 0;
  private readonly liveTargets = new Map<string, { track: ClipIRTrack; handle: CharacterPlaybackHandle; releasing: boolean }>();
  private readonly hairObjects = new Map<string, Mesh>();
  private hairConfig: JsonObject = {};
  private hairAppearance: JsonObject = {
    hairColor: copy(DEFAULT_HAIR_COLOR_APPEARANCE),
    eyebrowColor: copy(DEFAULT_HAIR_COLOR_APPEARANCE),
    showOutline: false, outlineColor: '#000000', outlineOpacity: 1,
  };

  constructor(private readonly config: RustEmbodyHostConfig = {}) {
    const mode = config.profileMode ?? 'preset';
    if (mode !== 'profile' && mode !== 'preset') throw new Error(`Unknown profile mode: ${mode}`);
    if (mode === 'profile' && !config.profile) throw new Error('Resolved profile mode requires a profile object.');
    this.profileMode = mode;
    this.preset = presetId(config.presetId ?? config.presetType);
    if (mode === 'preset' && !this.wasm.has_preset(this.preset)) throw new Error(`Unknown Embody preset: ${this.preset}`);
    this.profileSource = this.validateProfile(config.profile ?? {});
    this.profile = this.resolveProfile(this.profileSource);
    this.core = new this.wasm.RuntimeCore(0);
  }

  static async create(config: RustEmbodyHostConfig = {}): Promise<Embody> {
    await initEmbodyCore();
    return new Embody(config);
  }

  private assertAlive(): void { if (this.disposed) throw new Error('Character is disposed.'); }
  private requireModel(): Object3D {
    this.assertAlive();
    if (!this.boundModel) throw new Error('Bind a character model with onReady before using this operation.');
    return this.boundModel;
  }
  private requireConnector(): ThreeNativePlaybackConnector {
    this.requireModel();
    if (!this.connector) throw new Error('Character playback is not bound.');
    return this.connector;
  }
  private validateProfile(value: JsonObject): JsonObject {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Embody profile must be a JSON object.');
    return copy(value);
  }
  private resolveProfile(value: JsonObject): JsonObject {
    return this.profileMode === 'profile' ? copy(value) : parse(this.wasm.merge_embedded_preset(this.preset, json(value)));
  }

  onReady(options: { model: Object3D; meshes?: Mesh[]; animations?: AnimationClip[]; referencePose?: ThreeModelReferencePose }): void {
    this.assertAlive();
    const model = options.model;
    if (!model?.isObject3D) throw new Error('onReady requires a Three Object3D model.');
    const reference = this.references.get(model) ?? options.referencePose ?? (!this.boundModel ? this.config.referencePose : undefined) ?? captureModelReferencePose(model);
    const inspection = this.inspector.inspectModel(model, { meshes: options.meshes, profile: this.profile, referencePose: reference });
    this.bind(model, reference, inspection, this.profileSource, this.profile);
    if (options.animations) this.loadAnimationClips(options.animations);
  }

  private bind(model: Object3D, reference: ThreeModelReferencePose, inspection: ThreeModelInspection, source: JsonObject, profile: JsonObject, preserveLiveState = true): void {
    // Prepare every fallible profile/reference operation before releasing the old binding.
    const referenceBindings = bindModelReferencePose(model, reference);
    // Inspection stays live; release clips need the separately captured baseline.
    const runtimeDescriptor = {
      ...inspection.descriptor,
      morphTargets: inspection.descriptor.morphTargets.map((morph) => {
        const binding = inspection.morphBindings.get(morph.id);
        const baseline = binding && referenceBindings.get(binding.mesh)?.morphInfluences?.[binding.index];
        return { ...morph, initialValue: baseline ?? morph.initialValue };
      }),
    };
    const replacingModel = !!this.boundModel && this.boundModel !== model;
    const core = new this.wasm.RuntimeCore(0);
    try {
      if (this.profileMode === 'profile') core.configure_with_profile(json(source), json(runtimeDescriptor));
      else core.configure_with_preset(this.preset, json(source), json(runtimeDescriptor));
      if (preserveLiveState && this.boundModel) core.copy_live_state_from(this.core);
      for (const registered of replacingModel ? [] : this.sources.values()) {
        if (registered.kind === 'native') {
          const [clip] = serializeAnimationClips(model, [registered.clip], inspection);
          core.register_animation_clip(json(clip), 'baked');
        }
      }
    } catch (error) { core.free(); throw error; }
    try { this.connector?.dispose(); }
    catch (error) { core.free(); throw error; }
    this.core.free();
    this.core = core;
    if (replacingModel) this.sources.clear();
    this.boundModel = model;
    this.inspection = inspection;
    this.referenceBindings = referenceBindings;
    this.references.set(model, reference);
    this.profileSource = source;
    this.profile = profile;
    this.bindingGeneration += 1;
    this.playbacks.clear();
    this.current.clear();
    this.liveTargets.clear();
    this.meshes.splice(0, this.meshes.length, ...(inspection.morphMeshes.length ? inspection.morphMeshes : inspection.allMeshes));
    this.meshByName = inspection.meshByName;
    this.bones = inspection.bones;
    this.applier.setBindings(inspection);
    this.applier.applyMeshMaterialConfigs(model, profile.meshes ?? {});
    const session = new this.wasm.NativePlaybackSession();
    try {
      this.connector = new ThreeNativePlaybackConnector(session, {
        model, inspection,
        onRelease: (id) => {
          const playback = this.playbacks.get(id);
          if (playback?.terminal) this.forget(playback);
        },
      });
    }
    catch (error) { session.free(); throw error; }
    this.connector.rebind(model.uuid, String(this.bindingGeneration));
    this.connector.setRendering(this.rendering);
    this.connector.setTimeScale(this.timeScale);
    this.connector.subscribe((event) => this.onPlaybackEvent(event));
    this.hairConfig = parse(this.core.get_hair_config_json());
    this.registerHairObjects(inspection.allMeshes.filter((mesh) => ['hair', 'eyebrow'].includes(this.meshCategory(mesh))));
    if (preserveLiveState) this.commitLive();
  }

  bindModel(meshes?: Mesh[]): void {
    const model = this.requireModel();
    const reference = this.references.get(model)!;
    const inspection = this.inspector.inspectModel(model, { meshes, profile: this.profile, referencePose: reference });
    this.bind(model, reference, inspection, this.profileSource, this.profile);
  }
  extendReferencePose(): ThreeModelReferencePose {
    const model = this.requireModel();
    const reference = extendModelReferencePose(model, this.references.get(model)!);
    const inspection = this.inspector.inspectModel(model, { profile: this.profile, referencePose: reference });
    this.bind(model, reference, inspection, this.profileSource, this.profile);
    return reference;
  }
  setProfile(value: JsonObject): void {
    this.assertAlive();
    const source = this.validateProfile(value);
    const profile = this.resolveProfile(source);
    if (!this.boundModel) { this.profileSource = source; this.profile = profile; return; }
    const reference = this.references.get(this.boundModel)!;
    const inspection = this.inspector.inspectModel(this.boundModel, { profile, referencePose: reference });
    this.bind(this.boundModel, reference, inspection, source, profile, false);
  }
  getProfile(): JsonObject { return this.profile; }
  getProfileMode(): 'preset' | 'profile' { return this.profileMode; }
  getPresetId(): string | null { return this.profileMode === 'preset' ? this.preset : null; }
  supportsPreset(value?: string): boolean { return supportsRustEmbodyPreset(value); }

  private onPlaybackEvent(event: ThreeNativePlaybackEvent): void {
    if (this.playDepth) { this.pendingEvents.push(event); return; }
    const playback = this.playbacks.get(event.handle);
    if (!playback) return;
    playback.terminal = true;
    if (!playback.connector.getAction(playback.id)) {
      this.playbacks.delete(playback.id);
      if (this.current.get(playback.source.name) === playback) this.current.delete(playback.source.name);
    }
    playback.notify({ ...event, actionId: event.handle, clipName: playback.source.name });
  }
  private compile(source: Source, options: CharacterPlaybackOptions): ClipIR {
    const buildOptions = { ...('options' in source ? source.options : {}), ...options, intensityScale: intensity(options) };
    switch (source.kind) {
      case 'curves': return parse(this.core.build_clip(source.name, json(source.input), json(buildOptions)));
      case 'typed': return parse(this.core.build_typed_clip(source.name, json(source.input), json(buildOptions)));
      case 'compiled': return source.clip;
      case 'native': throw new Error('Native animation sources do not require AU compilation.');
    }
  }

  private restValues(track: KeyframeTrack): number[] | undefined {
    const model = this.requireModel();
    const parsed = PropertyBinding.parseTrackName(track.name);
    let object = PropertyBinding.findNode(model, parsed.nodeName) as Object3D | undefined;
    if (parsed.objectName === 'bones' && object) {
      const skeleton = (object as Object3D & { skeleton?: { bones: Object3D[] } }).skeleton;
      object = skeleton?.bones.find((bone) => bone.name === String(parsed.objectIndex)) ??
        skeleton?.bones[Number(parsed.objectIndex)];
    }
    if (!object) return undefined;
    const reference = this.referenceBindings.get(object);
    if (!reference) return undefined;
    switch (parsed.propertyName) {
      case 'quaternion': return Object.values(reference.transform.rotation);
      case 'rotation': {
        const rotation = reference.transform.rotation;
        const euler = reference.rotationEuler ?? new Euler().setFromQuaternion(new Quaternion(rotation.x, rotation.y, rotation.z, rotation.w), reference.rotationOrder);
        const axis = parsed.propertyIndex;
        return axis === 'x' || axis === 'y' || axis === 'z' ? [euler[axis]] : [euler.x, euler.y, euler.z];
      }
      case 'position': return Object.values(reference.transform.position);
      case 'scale': return Object.values(reference.transform.scale);
      case 'weights':
      case 'morphTargetInfluences': {
        const mesh = object as Mesh;
        const index = typeof parsed.propertyIndex === 'string' && !/^\d+$/.test(parsed.propertyIndex)
          ? mesh.morphTargetDictionary?.[parsed.propertyIndex] : Number(parsed.propertyIndex);
        return [reference.morphInfluences?.[index ?? -1] ?? 0];
      }
      default: return undefined;
    }
  }

  private materialize(source: Source, options: CharacterPlaybackOptions, inheritedStarts = new Map<string, number[]>()): AnimationClip {
    if (!this.inspection) throw new Error('Character has no model inspection.');
    const nativeSource = source.kind === 'native';
    let ir: ClipIR | undefined;
    if (!nativeSource) {
      ir = this.compile(source, options);
    }
    const clip = nativeSource ? withComponentTracks(source.clip).clone() : createAnimationClipFromClipIR(ir!, this.inspection);
    if (ir) {
      const predecessor = this.current.get(source.name);
      const outgoing = predecessor?.connector.getAction(predecessor.id);
      for (let index = 0; index < ir.tracks.length; index += 1) {
        if (!ir.tracks[index].inheritStart) continue;
        const track = clip.tracks[index];
        if (!track) throw new Error('Every inherited track must bind to the character.');
        const startKey = `${index}:${track.name}`;
        let previous = inheritedStarts.get(startKey);
        if (!previous && options.blendMode === 'additive') {
          // Additive inheritance belongs to this request's contribution, not
          // the full mixed pose containing baked clips and other controls.
          const rest = this.restValues(track);
          const candidates = outgoing?.getClip().tracks;
          const oldTrack = candidates?.[index]?.name === track.name ? candidates[index] : candidates?.find((candidate) => candidate.name === track.name);
          if (oldTrack && outgoing) {
            previous = Array.from((oldTrack as NativeTrack).createInterpolant().evaluate(outgoing.time));
            if (outgoing.blendMode === AdditiveAnimationBlendMode && rest) {
              previous = track.ValueTypeName === 'quaternion'
                ? new Quaternion().fromArray(rest).multiply(new Quaternion().fromArray(previous)).toArray()
                : previous.map((value, axis) => value + rest[axis]);
            }
          } else if (rest) previous = rest;
        }
        if (previous) track.values.set(previous, 0);
        inheritedStarts.set(startKey, previous ?? Array.from(track.values.subarray(0, track.getValueSize())));
      }
    }
    const authoredAdditive = clip.blendMode === AdditiveAnimationBlendMode;
    const scale = intensity(options);
    const additive = options.blendMode === 'additive' || (options.blendMode === undefined && authoredAdditive);
    // Native custom curves remain exact at their authored settings. Editing
    // strength/blend/easing materializes their native interpolant once into
    // ordinary keyframes; no custom sampling occurs during rendering.
    this.applyEasing(clip, options.easing ?? 'linear', nativeSource && (scale !== 1 || additive !== authoredAdditive));
    if (nativeSource && scale !== 1) {
      for (const track of clip.tracks) {
        const rest = authoredAdditive ? (track.ValueTypeName === 'quaternion' ? [0, 0, 0, 1] : Array(track.getValueSize()).fill(0)) : this.restValues(track);
        if (!rest) continue;
        const stride = track.getValueSize();
        const cubic = (track as NativeTrack).createInterpolant.isInterpolantFactoryMethodGLTFCubicSpline === true;
        const width = cubic ? stride / 3 : stride;
        for (let offset = 0; offset < track.values.length; offset += stride) {
          const sample = offset + (cubic ? width : 0);
          if (track.ValueTypeName === 'quaternion') {
            const neutral = new Quaternion().fromArray(rest);
            const value = new Quaternion().fromArray(track.values, sample);
            neutral.slerp(value, scale).toArray(track.values, sample);
          } else {
            for (let axis = 0; axis < width; axis += 1) {
              track.values[sample + axis] = rest[axis] + (track.values[sample + axis] - rest[axis]) * scale;
              if (cubic) {
                track.values[offset + axis] *= scale;
                track.values[offset + 2 * width + axis] *= scale;
              }
            }
          }
        }
      }
    }
    if (additive && !authoredAdditive) {
      const reference = clip.clone();
      for (const track of reference.tracks) {
        const rest = this.restValues(track);
        if (!rest) continue;
        const width = track.getValueSize();
        for (let offset = 0; offset < track.values.length; offset += width) track.values.set(rest, offset);
      }
      const explicitReference = options.additiveReferenceTimeSec;
      if (finite(explicitReference)) AnimationUtils.makeClipAdditive(clip, explicitReference * 30, clip.clone(), 30);
      else AnimationUtils.makeClipAdditive(clip, 0, reference, 30);
    }
    if (!additive && authoredAdditive) {
      // Native additive clips contain offsets; restore captured reference values.
      for (const track of clip.tracks) {
        const rest = this.restValues(track);
        if (!rest) continue;
        const width = track.getValueSize();
        for (let offset = 0; offset < track.values.length; offset += width) {
          if (track.ValueTypeName === 'quaternion') new Quaternion().fromArray(rest).multiply(new Quaternion().fromArray(track.values, offset)).toArray(track.values, offset);
          else for (let axis = 0; axis < width; axis += 1) track.values[offset + axis] += rest[axis];
        }
      }
    }
    clip.blendMode = additive ? AdditiveAnimationBlendMode : NormalAnimationBlendMode;
    return clip;
  }

  private applyEasing(clip: AnimationClip, easing: string, resampleCustom = false): void {
    if (easing === 'linear' && !resampleCustom) return;
    const curve = (progress: number): number => {
      switch (easing) {
        case 'easeIn': return progress * progress;
        case 'easeOut': return 1 - (1 - progress) ** 2;
        case 'easeInOut': return progress < 0.5 ? 2 * progress * progress : 1 - (-2 * progress + 2) ** 2 / 2;
        case 'easeInOutCubic': return progress < 0.5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2;
        default: return progress;
      }
    };
    for (const track of clip.tracks) {
      if (track.getInterpolation() === InterpolateDiscrete || track.times.length === 0) continue;
      const customInterpolant = (track as NativeTrack).createInterpolant.isInterpolantFactoryMethodGLTFCubicSpline === true;
      if (track.times.length === 1) {
        if (customInterpolant && resampleCustom) {
          track.values = new Float32Array((track as NativeTrack).createInterpolant().evaluate(track.times[0]));
          track.setInterpolation(InterpolateLinear);
        }
        continue;
      }
      if ((customInterpolant || track.getInterpolation() !== InterpolateLinear) && easing === 'linear' && !resampleCustom) continue;
      const stride = track.getValueSize();
      const width = customInterpolant ? stride / 3 : stride;
      const interpolant = (track as NativeTrack).createInterpolant();
      const times: number[] = [];
      const values: number[] = [];
      const append = (time: number, value: ArrayLike<number>) => { times.push(time); for (let axis = 0; axis < width; axis += 1) values.push(value[axis]); };
      for (let index = 0; index < track.times.length - 1; index += 1) {
        const start = track.times[index];
        const end = track.times[index + 1];
        // Retain duplicate keyframe times and their authored values verbatim.
        const offset = index * stride + (customInterpolant ? width : 0);
        append(start, track.values.subarray(offset, offset + width));
        if (end <= start) continue;
        for (let part = 1; part < 16; part += 1) {
          const progress = part / 16;
          append(start + (end - start) * progress, interpolant.evaluate(start + (end - start) * curve(progress)));
        }
      }
      const lastOffset = (track.times.length - 1) * stride + (customInterpolant ? width : 0);
      append(track.times[track.times.length - 1], track.values.subarray(lastOffset, lastOffset + width));
      track.times = new Float32Array(times);
      track.values = new Float32Array(values);
      if (customInterpolant || track.getInterpolation() !== InterpolateLinear) track.setInterpolation(InterpolateLinear);
    }
  }

  private nativeOptions(options: CharacterPlaybackOptions, clip: AnimationClip): ThreeNativePlaybackOptions {
    const mode = clip.duration === 0 ? 'once' : options.loopMode ?? (options.loop === true ? 'repeat' : 'once');
    const count = finite(options.repeatCount) && options.repeatCount > 0 ? options.repeatCount : null;
    let speed = options.speed ?? options.playbackRate ?? options.rate ?? options.timeScale ?? 1;
    if (options.reverse === true) speed = -Math.abs(speed);
    return {
      startSeconds: finite(options.time) ? options.time : finite(options.offsetSec) ? options.offsetSec : speed < 0 ? clip.duration : 0,
      speed,
      weight: finite(options.mixerWeight) ? options.mixerWeight : 1,
      blendMode: clip.blendMode === AdditiveAnimationBlendMode ? 'additive' : 'normal',
      loop: { mode: mode === 'once' ? 'once' : mode === 'pingpong' || mode === 'pingPong' ? 'pingPong' : 'repeat', count: mode === 'once' ? 1 : count },
      finalPose: options.finalPose === 'release' || options.clampWhenFinished === false ? 'release' : 'hold',
    };
  }
  private validateEasing(options: CharacterPlaybackOptions): void {
    if (options.easing !== undefined && !['linear', 'easeIn', 'easeOut', 'easeInOut', 'easeInOutCubic'].includes(options.easing)) throw new Error(`Unknown playback easing: ${options.easing}`);
  }

  private distancePredecessor(name: string): DistancePredecessor | undefined {
    const playback = this.current.get(name);
    const action = playback?.connector.getAction(playback.id);
    return playback && action ? { basis: playback.distanceBasis, action, terminal: playback.terminal } : undefined;
  }

  private validateDistanceSource(source: Source, options: CharacterPlaybackOptions): void {
    if (options.distanceTiming === undefined) return;
    if (source.kind !== 'curves') throw new Error('distanceTiming requires ordinary numeric AU curves.');
    validateDistanceTiming(source.input, options);
    validateDistancePredecessor(source.input, options, this.distancePredecessor(source.name), this.distanceMixWeights(source, options));
  }

  private continuumPairs(): ContinuumPairs {
    // Pairs come from the bound core's profile. Every profile/model change
    // replaces that core, so its identity scopes this read-only lookup.
    if (this.continuumPairCache?.core !== this.core) {
      const pairs = new Map<string, readonly [string, string]>();
      for (const descriptor of this.getAUDescriptors()) {
        if (descriptor.negativeAuId != null && descriptor.positiveAuId != null) {
          pairs.set(String(descriptor.auId), [String(descriptor.negativeAuId), String(descriptor.positiveAuId)]);
        }
      }
      this.continuumPairCache = { core: this.core, pairs };
    }
    return this.continuumPairCache.pairs;
  }

  private distanceMixWeights(source: Extract<Source, { kind: 'curves' | 'typed' }>, options: CharacterPlaybackOptions): Record<string, number> {
    // Rust remains authoritative for saved/live morph mixing. Capture only the
    // effective scalar inputs to this admission, never a second live AU state.
    return Object.fromEntries(Object.keys(source.input).map(id =>
      [id, Math.fround(options.mixWeights?.[id] ?? this.core.get_au_mix_weight(Number(id)))]));
  }

  private handle(source: Source, options: CharacterPlaybackOptions, autoPlay: boolean): CharacterPlaybackHandle {
    options = { ...('options' in source ? source.options : {}), ...options };
    const listeners = new Set<(event: CharacterPlaybackEvent) => void>();
    const generation = this.bindingGeneration;
    let current: Playback | undefined;
    let resolvePromise: (event: CharacterPlaybackEvent) => void = () => {};
    const result = { name: source.name } as CharacterPlaybackHandle;
    Object.defineProperty(result, 'finished', { get: () => result.promise, enumerable: true });
    const newPromise = () => { result.promise = new Promise((resolve) => { resolvePromise = resolve; }); };
    newPromise();
    result.subscribe = (listener) => {
      const callback = typeof listener === 'function' ? listener : (event: CharacterPlaybackEvent) => listener.next(event);
      listeners.add(callback);
      return () => { listeners.delete(callback); };
    };
    const start = (): CharacterPlaybackHandle => {
      if (generation !== this.bindingGeneration) throw new Error('Playback handle belongs to an obsolete model binding.');
      this.validateEasing(options);
      const connector = this.requireConnector();
      this.validateDistanceSource(source, options);
      const timing = source.kind !== 'curves' || options.distanceTiming === undefined ? undefined : prepareDistanceTiming(
        source.input,
        options, intensity(options), this.distancePredecessor(source.name), this.distanceMixWeights(source, options),
        this.continuumPairs(),
      );
      const inheritedStarts = new Map<string, number[]>();
      const clip = this.materialize(source, options, inheritedStarts);
      if (timing) {
        // The authored goal is nominally one second. Retime only this fresh
        // native clip at admission; the native action owns all later progress.
        for (const track of clip.tracks) track.scale(timing.durationSec);
        clip.duration = timing.durationSec;
      }
      const hairMotion = this.authoredHeadMotion(clip);
      const previous = this.current.get(source.name);
      const settings = this.nativeOptions(options, clip);
      if (previous && connector.getAction(previous.id)) settings.replace = previous.id;
      if (current) newPromise();
      const resolve = resolvePromise;
      let settled = false;
      this.playDepth += 1;
      let id: string;
      try { id = connector.playNativeClip(clip, settings); }
      catch (error) {
        this.playDepth -= 1;
        while (!this.playDepth && this.pendingEvents.length) this.onPlaybackEvent(this.pendingEvents.shift()!);
        throw error;
      }
      const playback: Playback = {
        id, source, options: { ...options, intensityScale: intensity(options) }, connector, terminal: false, inheritedStarts,
        distanceBasis: timing?.basis,
        replay: (next) => { options = next; return start(); },
        notify: (event) => {
          if (settled) return;
          settled = true;
          resolve(event);
          for (const listener of [...listeners]) {
            try { listener(event); }
            catch (error) { queueMicrotask(() => { throw error; }); }
          }
        },
      };
      current = playback;
      result.actionId = id;
      this.playbacks.set(id, playback);
      this.current.set(source.name, playback);
      const ensure = () => {
        this.assertAlive();
        if (this.connector !== connector || !connector.getAction(id)) throw new Error('Unknown, released or obsolete playback handle.');
      };
      const control = (command: ThreeNativePlaybackControl): CharacterPlaybackHandle => {
        ensure();
        connector.control(id, command);
        if (command.type === 'stop') this.forget(playback);
        return result;
      };
      result.stop = result.cancel = () => {
        if (this.connector !== connector || !connector.getAction(id)) return result;
        ensure();
        const seconds = finite(playback.options.fadeOutSec) ? playback.options.fadeOutSec : 0;
        if (seconds > 0 && !playback.terminal) connector.fadeOut(id, seconds);
        else control({ type: 'stop' });
        return result;
      };
      result.pause = () => control({ type: 'pause' });
      result.resume = () => {
        ensure();
        if (playback.terminal) {
          options = { ...playback.options, time: playback.distanceBasis ? 0 : connector.getAction(id)!.time,
            ...(playback.distanceBasis ? { offsetSec: 0 } : {}) };
          return start();
        }
        return control({ type: 'resume' });
      };
      result.setSpeed = result.setPlaybackRate = (speed) => { ensure(); this.updatePlayback(playback, { speed }); return result; };
      result.setTime = result.seek = (seconds) => control({ type: 'seek', seconds });
      result.setWeight = result.setIntensity = (value) => {
        ensure();
        this.updatePlayback(playback, { intensityScale: value });
        return result;
      };
      result.updateParams = result.setParams = (value) => { ensure(); this.updatePlayback(playback, value); return result; };
      try {
        const fade = options.fadeInSec ?? options.crossfadeDuration;
        if (finite(fade) && fade > 0) connector.fadeIn(id, fade);
      } finally {
        this.playDepth -= 1;
        while (!this.playDepth && this.pendingEvents.length) this.onPlaybackEvent(this.pendingEvents.shift()!);
      }
      if (hairMotion && connector.getAction(id)) {
        this.playHairImpulse(hairMotion.horizontal, hairMotion.vertical);
        this.setHairGravity(hairMotion.pitch, clip.duration);
      }
      return result;
    };
    result.play = () => {
      if (current) options = { ...current.options, ...(current.distanceBasis ? { time: 0, offsetSec: 0 } : {}) };
      return start();
    };
    const beforePlay = () => { throw new Error('Play this compiled clip before changing playback.'); };
    // A prepared clip has options but owns no native action to stop or pause.
    result.stop = result.cancel = () => result;
    result.pause = result.resume = beforePlay;
    result.updateParams = result.setParams = (patch) => {
      this.assertAlive();
      this.validateEasing(patch);
      const nextOptions = { ...options, ...patch };
      if ('finalPose' in patch && !('clampWhenFinished' in patch)) nextOptions.clampWhenFinished = patch.finalPose !== 'release';
      if ('clampWhenFinished' in patch && !('finalPose' in patch)) nextOptions.finalPose = patch.clampWhenFinished === false ? 'release' : 'hold';
      if ('loop' in patch && !('loopMode' in patch)) nextOptions.loopMode = patch.loop ? 'repeat' : 'once';
      if ('loopMode' in patch && !('repeatCount' in patch)) delete nextOptions.repeatCount;
      if ('weight' in patch || 'intensity' in patch || 'intensityScale' in patch) nextOptions.intensityScale = intensity(patch);
      if ('time' in patch || 'offsetSec' in patch) nextOptions.time = patch.time ?? patch.offsetSec;
      if ('speed' in patch || 'playbackRate' in patch || 'rate' in patch || 'timeScale' in patch || 'reverse' in patch) {
        let speed = patch.speed ?? patch.playbackRate ?? patch.rate ?? patch.timeScale ?? nextOptions.speed ?? nextOptions.playbackRate ?? nextOptions.rate ?? nextOptions.timeScale ?? 1;
        if ('reverse' in patch) speed = Math.abs(speed) * (patch.reverse ? -1 : 1);
        nextOptions.speed = speed;
        delete nextOptions.reverse;
      }
      this.validateDistanceSource(source, nextOptions);
      options = nextOptions;
      return result;
    };
    result.setWeight = result.setIntensity = (value) => result.updateParams({ intensityScale: value });
    result.setSpeed = result.setPlaybackRate = (speed) => result.updateParams({ speed });
    result.setTime = result.seek = (time) => result.updateParams({ time });
    return autoPlay ? start() : result;
  }

  private forget(playback: Playback): void {
    this.playbacks.delete(playback.id);
    if (this.current.get(playback.source.name) === playback) this.current.delete(playback.source.name);
  }
  private updatePlayback(playback: Playback, patch: CharacterPlaybackOptions): void {
    this.validateEasing(patch);
    if (patch.distanceTiming !== undefined || (playback.distanceBasis &&
        Object.keys(patch).some(key => !['time', 'offsetSec', 'finalPose', 'clampWhenFinished'].includes(key)))) {
      throw new Error('distanceTiming playback timing and semantic options require a new ordinary play request.');
    }
    const connector = playback.connector;
    const action = connector.getAction(playback.id);
    if (connector !== this.connector || !action) throw new Error('Unknown, released or obsolete playback handle.');
    const options = { ...playback.options, ...patch };
    if ('finalPose' in patch && !('clampWhenFinished' in patch)) options.clampWhenFinished = patch.finalPose !== 'release';
    if ('clampWhenFinished' in patch && !('finalPose' in patch)) options.finalPose = patch.clampWhenFinished === false ? 'release' : 'hold';
    if ('loop' in patch && !('loopMode' in patch)) options.loopMode = patch.loop ? 'repeat' : 'once';
    if ('loopMode' in patch && !('repeatCount' in patch)) delete options.repeatCount;
    if ('weight' in patch || 'intensity' in patch || 'intensityScale' in patch) options.intensityScale = intensity(patch);
    if (['weight', 'intensity', 'intensityScale', 'blendMode', 'easing', 'balance', 'balanceMap', 'mixWeights'].some((key) => key in patch)) {
      const clip = this.materialize(playback.source, options, playback.inheritedStarts);
      connector.replaceClip(playback.id, clip);
      if ('blendMode' in patch) connector.control(playback.id, { type: 'setBlendMode', blendMode: clip.blendMode === AdditiveAnimationBlendMode ? 'additive' : 'normal' });
    }
    if ('mixerWeight' in patch) connector.control(playback.id, { type: 'setWeight', weight: patch.mixerWeight });
    if ('speed' in patch || 'playbackRate' in patch || 'rate' in patch || 'timeScale' in patch || 'reverse' in patch) {
      let speed = patch.speed ?? patch.playbackRate ?? patch.rate ?? patch.timeScale ?? action.timeScale;
      if ('reverse' in patch) speed = Math.abs(speed) * (patch.reverse ? -1 : 1);
      connector.control(playback.id, { type: 'setSpeed', speed });
      options.speed = speed;
      delete options.reverse;
    }
    if ('time' in patch || 'offsetSec' in patch) {
      options.time = patch.time ?? patch.offsetSec;
      connector.control(playback.id, { type: 'seek', seconds: options.time });
    }
    if ('loopMode' in patch || 'loop' in patch || 'repeatCount' in patch) {
      if (playback.terminal) {
        playback.replay({ ...options, time: action.time });
        return;
      }
      connector.control(playback.id, { type: 'setLoop', loop: this.nativeOptions(options, action.getClip()).loop! });
    }
    if ('clampWhenFinished' in patch || 'finalPose' in patch) connector.control(playback.id, { type: 'setFinalPose', finalPose: this.nativeOptions(options, action.getClip()).finalPose! });
    playback.options = options;
    if (!connector.getAction(playback.id)) this.forget(playback);
  }

  registerAnimationClips(clips: AnimationClip[]): void {
    const model = this.requireModel();
    for (const clip of clips) {
      if (this.sources.get(clip.name)?.kind === 'native' && (this.sources.get(clip.name) as { clip: AnimationClip }).clip === clip) continue;
      const [ir] = serializeAnimationClips(model, [clip], this.inspection!);
      this.core.register_animation_clip(json(ir), 'baked');
      this.sources.set(clip.name, { name: clip.name, kind: 'native', clip });
    }
  }
  loadAnimationClips(clips: AnimationClip[]): void {
    this.stopAllAnimations();
    for (const source of [...this.sources.values()]) if (source.kind === 'native') {
      this.sources.delete(source.name);
      this.core.remove_animation_clip(source.name);
    }
    this.registerAnimationClips(clips ?? []);
    this.restartHair();
  }
  removeAnimationClip(name: string): boolean {
    this.stopAnimation(name);
    this.sources.delete(name);
    return this.core.remove_animation_clip(name);
  }
  getAnimationClips(): any[] { return parse(this.core.get_animation_clips()); }
  playAnimation(name: string, options: CharacterPlaybackOptions = {}): CharacterPlaybackHandle {
    const source = this.sources.get(name);
    if (!source) throw new Error(`Unknown animation clip: ${name}`);
    return this.handle(source, options, true);
  }
  private build(source: Source, options: CharacterPlaybackOptions, play: boolean): CharacterPlaybackHandle {
    this.requireModel();
    this.validateEasing(options);
    this.validateDistanceSource(source, options);
    // Immediate play validates/measures native distance before materialize()
    // compiles and registers the source. Prepared authoring still compiles its
    // nominal source now and resolves timing only when explicitly played.
    if (!play) this.compile(source, options);
    const handle = this.handle(source, options, play);
    this.sources.set(source.name, source);
    return handle;
  }
  buildClip(name: string, curves: JsonObject, options: CharacterPlaybackOptions = {}): CharacterPlaybackHandle {
    if (options.semanticAnimation) throw new Error('Decode legacy named animation tracks to numeric AU curves before building a clip.');
    return this.build({ name, kind: 'curves', input: copy(curves), options: copy(options) }, options, false);
  }
  snippetToClip(name: string, curves: JsonObject, options: CharacterPlaybackOptions = {}): CharacterPlaybackHandle { return this.buildClip(name, curves, options); }
  buildTypedClip(name: string, channels: any[], options: CharacterPlaybackOptions = {}): CharacterPlaybackHandle {
    return this.build({ name, kind: 'typed', input: copy(channels), options: copy(options) }, options, false);
  }
  typedSnippetToClip(name: string, channels: any[], options: CharacterPlaybackOptions = {}): CharacterPlaybackHandle { return this.buildTypedClip(name, channels, options); }
  playSnippet(name: string, curves: JsonObject, options?: CharacterPlaybackOptions): CharacterPlaybackHandle;
  playSnippet(snippet: { name: string; curves: JsonObject }, options?: CharacterPlaybackOptions): CharacterPlaybackHandle;
  playSnippet(snippet: string | { name: string; curves: JsonObject }, curvesOrOptions: JsonObject = {}, options: CharacterPlaybackOptions = {}): CharacterPlaybackHandle {
    const name = typeof snippet === 'string' ? snippet : snippet.name;
    const curves = typeof snippet === 'string' ? curvesOrOptions : snippet.curves;
    const playbackOptions = typeof snippet === 'string' ? options : curvesOrOptions;
    if (playbackOptions.semanticAnimation) throw new Error('Decode legacy named animation tracks to numeric AU curves before building a clip.');
    return this.build({ name, kind: 'curves', input: copy(curves), options: copy(playbackOptions) }, playbackOptions, true);
  }
  playTypedSnippet(snippet: { name: string; channels: any[] }, options: CharacterPlaybackOptions = {}): CharacterPlaybackHandle { return this.buildTypedClip(snippet.name, snippet.channels, options).play(); }
  playClip(value: string | CharacterPlaybackHandle): CharacterPlaybackHandle { return typeof value === 'string' ? this.playAnimation(value) : value.play(); }
  supportsClipCurves(): boolean { return true; }
  cleanupSnippet(name: string): void { this.stopAnimation(name); this.sources.delete(name); this.core.cleanup_snippet(name); }
  crossfadeTo(name: string, seconds: number, options: CharacterPlaybackOptions = {}): CharacterPlaybackHandle {
    const outgoing = [...this.current.values()].filter((playback) => !playback.source.name.startsWith('__embody_'));
    const handle = this.playAnimation(name, { ...options, fadeInSec: seconds });
    for (const playback of outgoing) if (playback.connector.getAction(playback.id)) playback.connector.fadeOut(playback.id, seconds);
    return handle;
  }
  stopAnimation(name: string): void {
    const playback = this.current.get(name);
    if (!playback) return;
    if (playback.connector.getAction(playback.id)) playback.connector.control(playback.id, { type: 'stop' });
    this.forget(playback);
  }
  stopAllAnimations(): void {
    for (const playback of [...this.playbacks.values()]) {
      if (playback.source.kind === 'compiled') continue;
      if (playback.connector.getAction(playback.id)) playback.connector.control(playback.id, { type: 'stop' });
      this.forget(playback);
    }
  }
  pauseAnimation(name: string): void { const p = this.current.get(name); if (p) p.connector.control(p.id, { type: 'pause' }); }
  resumeAnimation(name: string): void {
    const p = this.current.get(name);
    if (!p) return;
    if (p.terminal) p.replay({ ...p.options, time: p.distanceBasis ? 0 : p.connector.getAction(p.id)?.time ?? 0,
      ...(p.distanceBasis ? { offsetSec: 0 } : {}) });
    else p.connector.control(p.id, { type: 'resume' });
  }
  pauseAllAnimations(): void { for (const p of this.playbacks.values()) if (!p.terminal) p.connector.control(p.id, { type: 'pause' }); }
  resumeAllAnimations(): void { for (const name of [...this.current.keys()]) this.resumeAnimation(name); }
  updateClipParams(name: string, options: CharacterPlaybackOptions): void { const p = this.current.get(name); if (p) this.updatePlayback(p, options); }
  setAnimationSpeed(name: string, value: number): void { this.updateClipParams(name, { speed: value }); }
  setAnimationIntensity(name: string, value: number): void { this.updateClipParams(name, { intensityScale: value }); }
  setAnimationLoop(name: string, value: boolean): void { this.updateClipParams(name, { loopMode: value ? 'repeat' : 'once' }); }
  setAnimationLoopMode(name: string, value: string): void { this.updateClipParams(name, { loopMode: value }); }
  setAnimationRepeatCount(name: string, value: number | null): void { this.updateClipParams(name, { loopMode: 'repeat', repeatCount: value }); }
  setAnimationReverse(name: string, value: boolean): void { this.updateClipParams(name, { reverse: value }); }
  setAnimationBlendMode(name: string, value: string): void { this.updateClipParams(name, { blendMode: value }); }
  setAnimationEasing(name: string, value: string): void { this.validateEasing({ easing: value }); this.updateClipParams(name, { easing: value }); }
  seekAnimation(name: string, value: number): void { this.updateClipParams(name, { time: value }); }
  setAnimationTime(name: string, value: number): void { this.seekAnimation(name, value); }
  setSnippetTime(name: string, value: number): void { this.seekAnimation(name, value); }
  seekSnippet(name: string, value: number): void { this.seekAnimation(name, value); }
  seek(name: string, value: number): void { this.seekAnimation(name, value); }
  setAnimationTimeScale(value: number): void { this.requireConnector().setTimeScale(value); this.timeScale = value; }
  getAnimationState(name: string): JsonObject {
    const p = this.current.get(name);
    const action = p?.connector.getAction(p.id);
    if (!action || !p) { if (p) this.forget(p); return { name, playing: false, isPlaying: false }; }
    const playing = action.isRunning();
    return { name, actionId: p.id, playing, isPlaying: playing, paused: action.paused, completed: p.terminal,
      time: action.time, duration: action.getClip().duration, speed: action.timeScale,
      intensityScale: intensity(p.options), mixerWeight: action.getEffectiveWeight(),
      loopMode: action.loop === LoopOnce ? 'once' : action.loop === LoopPingPong ? 'pingpong' : 'repeat',
      repeatCount: Number.isFinite(action.repetitions) ? action.repetitions : null,
      blendMode: action.blendMode === AdditiveAnimationBlendMode ? 'additive' : 'replace' };
  }
  getPlayingAnimations(): string[] { return [...this.current.keys()].filter((name) => this.getAnimationState(name).playing); }

  private commitLive(durationMs = 0): CharacterPlaybackHandle[] {
    const connector = this.requireConnector();
    const duration = Math.max(0, durationMs) / 1000;
    const clip = parse<ClipIR>(this.core.build_live_clip('__embody_live', duration));
    const touched = new Set(parse<ClipIRTrack['target'][]>(this.core.live_command_targets_json()).map(targetKey));
    const tracks = new Map<string, ClipIRTrack>(clip.tracks.map((track) => [targetKey(track.target), track]));
    const handles: CharacterPlaybackHandle[] = [];
    for (const [key, previous] of this.liveTargets) {
      if (tracks.has(key)) continue;
      if (previous.releasing && !touched.has(key)) continue;
      const action = previous.handle.actionId && connector.getAction(previous.handle.actionId);
      if (!action || duration === 0) {
        previous.handle.stop();
        this.liveTargets.delete(key);
        continue;
      }
      // Fade this action's own contribution. Inheriting the already mixed pose
      // would blend it a second time and jump when the released track disappears.
      const nativeTrack = action.getClip().tracks[0] as NativeTrack;
      const sample = Array.from(nativeTrack.createInterpolant().evaluate(action.time));
      const released: ClipIRTrack = { ...previous.track, times: [0, duration], values: [...sample, ...sample], inheritStart: false };
      const releaseClip = { ...clip, name: previous.handle.name, tracks: [released] };
      const handle = this.handle({ name: releaseClip.name, kind: 'compiled', clip: releaseClip },
        { loopMode: 'once', finalPose: 'release', mixerWeight: action.getEffectiveWeight() }, true);
      connector.fadeOut(handle.actionId!, duration);
      const record = { track: released, handle, releasing: true };
      this.liveTargets.set(key, record);
      void handle.promise.then(() => { if (this.liveTargets.get(key) === record) this.liveTargets.delete(key); });
      handles.push(handle);
    }
    for (const [key, track] of tracks) {
      const previous = this.liveTargets.get(key);
      const endpoint = (value: ClipIRTrack) => value.values.slice(value.values.length / value.times.length * (value.times.length - 1));
      // Rust identifies semantic command destinations. Concrete targets outside
      // that command keep their native action, including an intentionally cancelled one.
      if (previous && !previous.releasing && !touched.has(key) && json(endpoint(previous.track)) === json(endpoint(track))) continue;
      const name = previous?.handle.name ?? `__embody_live_${this.nextLiveTarget++}`;
      const outgoing = previous?.handle.actionId && connector.getAction(previous.handle.actionId);
      let nativeTrack = track;
      if (duration > 0 && outgoing) {
        const start = Array.from((outgoing.getClip().tracks[0] as NativeTrack).createInterpolant().evaluate(outgoing.time));
        nativeTrack = { ...track, values: [...start, ...endpoint(track)], inheritStart: false };
      }
      const targetClip = { ...clip, name, tracks: [nativeTrack] };
      const handle = this.handle({ name, kind: 'compiled', clip: targetClip }, { loopMode: 'once', finalPose: 'hold' }, true);
      this.liveTargets.set(key, { track, handle, releasing: false });
      handles.push(handle);
    }
    return handles;
  }
  private mutateLive(mutate: () => void, durationMs = 0): CharacterPlaybackHandle[] {
    this.requireModel();
    this.core.begin_live_command();
    mutate();
    return this.commitLive(durationMs);
  }
  private transition(handles: CharacterPlaybackHandle[]): CharacterTransitionHandle {
    // A single control may own several concrete tracks. Replacement of one
    // shared target must not settle or cancel its other independent targets.
    let settled = handles.length === 0;
    const promise = Promise.all(handles.map((handle) => handle.promise)).then(() => { settled = true; });
    const control = (command: 'pause' | 'resume' | 'cancel') => {
      if (settled) return;
      for (const handle of handles) {
        const playback = handle.actionId && this.playbacks.get(handle.actionId);
        if (!playback || !playback.connector.getAction(playback.id)) continue;
        if (command === 'cancel' || !playback.terminal) handle[command]();
      }
    };
    return { promise, pause: () => control('pause'), resume: () => control('resume'), cancel: () => control('cancel') };
  }
  setAU(id: number, value: number, balance = this.core.get_au_balance(id)): void { this.mutateLive(() => this.core.set_au_signed(id, value, balance)); }
  getAU(id: number): number { return this.core.get_au(id); }
  getAUBalance(id: number): number { return this.core.get_au_balance(id); }
  getAUDescriptors(): AUDescriptor[] { return parse(this.core.get_au_descriptors_json()); }
  setContinuum(negative: number, positive: number, value: number, balance = NaN): void { this.mutateLive(() => this.core.set_continuum(negative, positive, value, balance)); }
  getContinuum(negative: number, positive: number): number { return this.core.get_continuum(negative, positive); }
  transitionAU(id: number, value: number, durationMs = 200, balance = this.core.get_au_balance(id)): CharacterTransitionHandle { return this.transition(this.mutateLive(() => this.core.set_au_signed(id, value, balance), durationMs)); }
  setViseme(index: number, value: number, jawScale = 1): void { this.mutateLive(() => { this.core.set_viseme(index, value); this.core.set_viseme_jaw_scale(index, jawScale); }); }
  getViseme(index: number): number { return this.core.get_viseme(index); }
  getVisemeJawScale(index: number): number { return this.core.get_viseme_jaw_scale(index); }
  setVisemeById(id: string, value: number, jawScale = 1): void { const index = this.core.viseme_slot_index(id); if (index < 0) throw new Error(`Unknown viseme: ${id}`); this.setViseme(index, value, jawScale); }
  transitionViseme(index: number, value: number, durationMs = 80, jawScale = 1): CharacterTransitionHandle { return this.transition(this.mutateLive(() => { this.core.set_viseme(index, value); this.core.set_viseme_jaw_scale(index, jawScale); }, durationMs)); }
  transitionVisemeById(id: string, value: number, durationMs = 80, jawScale = 1): CharacterTransitionHandle { const index = this.core.viseme_slot_index(id); if (index < 0) return this.transition([]); return this.transitionViseme(index, value, durationMs, jawScale); }
  setAUMixWeight(id: number, value: number): void {
    const weight = Math.max(0, Math.min(1, value));
    this.mutateLive(() => this.core.set_au_mix_weight(id, weight));
    (this.profile.auMixDefaults ??= {})[id] = weight;
    (this.profileSource.auMixDefaults ??= {})[id] = weight;
  }
  getAUMixWeight(id: number): number { return this.core.get_au_mix_weight(id); }
  hasLeftRightBones(id: number): boolean { return this.core.has_left_right_bones(id); }
  setMorph(key: string | number, value: number, meshNames: string[] = []): void { this.mutateLive(() => { if (typeof key === 'number') this.core.set_morph_index(key, value, json(meshNames)); else this.core.set_morph(key, value, json(meshNames)); }); }
  setMorphOnMeshes(meshNames: string[], key: string | number, value: number): void { this.setMorph(key, value, meshNames); }
  releaseMorph(key: string | number, meshNames: string[] = []): void { this.mutateLive(() => { if (typeof key === 'number') this.core.release_morph_index(key, json(meshNames)); else this.core.release_morph(key, json(meshNames)); }); }
  transitionMorph(key: string | number, value: number, durationMs = 120, meshNames: string[] = []): CharacterTransitionHandle { return this.transition(this.mutateLive(() => { if (typeof key === 'number') this.core.set_morph_index(key, value, json(meshNames)); else this.core.set_morph(key, value, json(meshNames)); }, durationMs)); }

  getMorphTargets(): Record<string, string[]> { return Object.fromEntries(this.meshes.map((mesh) => [mesh.name, Object.keys(mesh.morphTargetDictionary ?? {}).sort()])); }
  getMorphTargetIndices(): Record<string, { name: string; index: number }[]> { return Object.fromEntries(this.meshes.map((mesh) => [mesh.name, Object.entries(mesh.morphTargetDictionary ?? {}).map(([name, index]) => ({ name, index })).sort((a, b) => a.index - b.index)])); }
  addMorphTarget(target: Parameters<ThreeFrameApplier['addMorphTarget']>[1], options?: Parameters<ThreeFrameApplier['addMorphTarget']>[2]): number { const index = this.applier.addMorphTarget(this.requireModel(), target, options); this.bindModel(); return index; }
  addMorphTargets(targets: Parameters<ThreeFrameApplier['addMorphTargets']>[1], options?: Parameters<ThreeFrameApplier['addMorphTargets']>[2]): Record<string, number> { const result = this.applier.addMorphTargets(this.requireModel(), targets, options); this.bindModel(); return result; }
  private meshCategory(mesh: Object3D): string { return this.profile.meshes?.[mesh.name]?.category ?? 'other'; }
  getMeshList(): JsonObject[] { return (this.inspection?.allMeshes ?? []).map((mesh) => ({ name: mesh.name, visible: mesh.visible, morphCount: mesh.morphTargetInfluences?.length ?? 0, category: this.meshCategory(mesh) })); }
  getBones(): ThreeModelInspection['bones'] { return this.bones; }
  private meshProfile(name: string): JsonObject { return (this.profile.meshes ??= {})[name] ??= { category: 'other' }; }
  setMeshVisible(name: string, visible: boolean): void { this.applier.setMeshVisible(this.requireModel(), name, visible); this.meshProfile(name).visible = visible; }
  highlightMesh(name: string | null, color?: number, value?: number): void { this.applier.highlightMesh(this.requireModel(), name, color, value); }
  getMeshMaterialConfig(name: string): Record<string, unknown> | null { return this.applier.getMeshMaterialConfig(this.requireModel(), name); }
  setMeshMaterialConfig(name: string, value: Parameters<ThreeFrameApplier['setMeshMaterialConfig']>[2]): void { this.applier.setMeshMaterialConfig(this.requireModel(), name, value); const entry = this.meshProfile(name); entry.material = { ...entry.material, ...value }; }

  registerHairObjects(objects: Object3D[]): { name: string; isMesh: boolean; isEyebrow: boolean }[] {
    this.hairObjects.clear();
    for (const object of objects) if ((object as Mesh).isMesh) this.hairObjects.set(object.name, object as Mesh);
    for (const category of ['hair', 'eyebrow']) {
      const mesh = [...this.hairObjects.values()].find((object) => this.meshCategory(object) === category);
      const material: any = mesh && (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material);
      if (material) this.hairAppearance[`${category}Color`] = { ...this.hairAppearance[`${category}Color`], baseColor: material.color ? `#${material.color.getHexString()}` : '#000000', emissive: material.emissive ? `#${material.emissive.getHexString()}` : '#000000', emissiveIntensity: material.emissiveIntensity ?? 0 };
    }
    this.restartHair();
    return [...this.hairObjects.values()].map((mesh) => ({ name: mesh.name, isMesh: true, isEyebrow: this.meshCategory(mesh) === 'eyebrow' }));
  }
  getRegisteredHairObjects(): Object3D[] { return [...this.hairObjects.values()]; }
  getHairMorphTargets(name?: string): string[] { const meshes = name ? [this.hairObjects.get(name)] : [...this.hairObjects.values()]; return [...new Set(meshes.flatMap((mesh) => Object.keys(mesh?.morphTargetDictionary ?? {})))].sort(); }
  getHairAppearance(): JsonObject { return copy(this.hairAppearance); }
  private setHairAppearance(category: 'hair' | 'eyebrow', value: string | JsonObject): void {
    const key = `${category}Color`;
    const next = parse(this.wasm.normalize_hair_color_appearance_json(json(value), json(this.hairAppearance[key])));
    this.hairAppearance[key] = next;
    this.applier.applyHairAppearance([...this.hairObjects.values()].filter((mesh) => this.meshCategory(mesh) === category), next);
  }
  setHairColor(value: string | JsonObject): void { this.setHairAppearance('hair', value); }
  setEyebrowColor(value: string | JsonObject): void { this.setHairAppearance('eyebrow', value); }
  setHairBaseColor(value: string): void { this.setHairColor({ baseColor: value }); }
  setEyebrowBaseColor(value: string): void { this.setEyebrowColor({ baseColor: value }); }
  setHairGlow(color: string, value: number): void { this.setHairColor({ emissive: color, emissiveIntensity: value }); }
  setEyebrowGlow(color: string, value: number): void { this.setEyebrowColor({ emissive: color, emissiveIntensity: value }); }
  setHairOutline(value: { show: boolean; color?: string; opacity?: number }): void { Object.assign(this.hairAppearance, { showOutline: value.show }, value.color ? { outlineColor: value.color } : {}, value.opacity !== undefined ? { outlineOpacity: value.opacity } : {}); }
  private restartHair(): void {
    for (const name of [...this.current.keys()]) if (name.startsWith('__embody_hair')) this.stopAnimation(name);
    if (!this.hairConfig.enabled || !this.hairObjects.size || !this.connector) return;
    if (this.hairConfig.idleSwayAmount > 0 || this.hairConfig.windStrength > 0) {
      const curves = parse(this.wasm.build_hair_idle_curves(json(this.hairConfig), this.hairConfig.idleClipDuration));
      if (Object.keys(curves).length) this.playSnippet('__embody_hair_idle', curves, { loopMode: 'repeat', meshNames: [...this.hairObjects.keys()], source: 'hair', blendMode: 'additive' });
    }
  }
  setHairPhysicsEnabled(value: boolean): void { this.setHairPhysicsConfig({ enabled: value }); }
  isHairPhysicsEnabled(): boolean { return !!this.hairConfig.enabled; }
  setHairPhysicsConfig(value: JsonObject): void { this.hairConfig = parse(this.core.set_hair_config_json(json(value))); this.restartHair(); }
  getHairPhysicsConfig(): JsonObject { return copy(this.hairConfig); }
  validateHairMorphTargets(): string[] {
    return parse(this.core.get_missing_hair_morph_targets_json(json(this.getHairMorphTargets())));
  }
  applyHairStateToObject(name: string, state: JsonObject): void {
    const mesh = this.hairObjects.get(name);
    if (!mesh) return;
    if (state.visible !== undefined) mesh.visible = state.visible;
    if (state.scale) mesh.scale.set(state.scale.x, state.scale.y, state.scale.z);
    if (state.position) mesh.position.set(state.position.x, state.position.y, state.position.z);
    if (state.color) this.applier.applyHairAppearance([mesh], state.color);
  }
  private authoredHeadMotion(clip: AnimationClip): { horizontal: number; vertical: number; pitch: number } | undefined {
    if (!this.hairConfig.enabled || clip.name.startsWith('__embody_hair') || !this.hairObjects.size) return undefined;
    // Serialize native bindings and sample storage only. The core resolves the
    // character's head role and compiles its configured hair response.
    const tracks: Array<{ boneName: string; current: number[]; reference: number[]; samples: number[][] }> = [];
    for (const track of clip.tracks) {
      if (track.ValueTypeName !== 'quaternion') continue;
      const parsed = PropertyBinding.parseTrackName(track.name);
      let object = PropertyBinding.findNode(this.requireModel(), parsed.nodeName) as Object3D | undefined;
      if (parsed.objectName === 'bones' && object) {
        const skeleton = (object as Object3D & { skeleton?: { bones: Object3D[] } }).skeleton;
        object = skeleton?.bones.find((bone) => bone.name === String(parsed.objectIndex)) ?? skeleton?.bones[Number(parsed.objectIndex)];
      }
      if (!object) continue;
      const cubic = (track as NativeTrack).createInterpolant.isInterpolantFactoryMethodGLTFCubicSpline === true;
      const stride = track.getValueSize();
      const reference = this.restValues(track);
      if (!reference) continue;
      const samples: number[][] = [];
      for (let index = 0; index < track.times.length; index += 1) {
        const offset = index * stride + (cubic ? 4 : 0);
        samples.push(Array.from(track.values.subarray(offset, offset + 4)));
      }
      tracks.push({ boneName: object.name, current: object.quaternion.toArray(), reference, samples });
    }
    return parse(this.core.resolve_hair_motion_json(json(tracks), clip.blendMode === AdditiveAnimationBlendMode)) ?? undefined;
  }
  private setHairGravity(pitch: number, durationSeconds: number): void {
    const clip = parse<ClipIR>(this.core.build_hair_gravity_clip('__embody_hair_gravity', pitch, durationSeconds, json({ meshNames: [...this.hairObjects.keys()], source: 'hair' })));
    if (!clip.tracks.length) return;
    this.handle({ name: clip.name, kind: 'compiled', clip }, { loopMode: 'once', finalPose: 'hold', blendMode: 'additive' }, true);
  }
  playHairImpulse(horizontal: number, vertical: number): CharacterPlaybackHandle | undefined {
    if (!this.hairConfig.enabled || !this.hairObjects.size) return undefined;
    const curves = parse(this.wasm.build_hair_impulse_curves(json(this.hairConfig), this.hairConfig.impulseClipDuration, horizontal, vertical));
    if (!Object.keys(curves).length) return undefined;
    return this.playSnippet('__embody_hair_impulse', curves, { loopMode: 'once', finalPose: 'release', meshNames: [...this.hairObjects.keys()], source: 'hair', blendMode: 'additive' });
  }
  start(): void { this.assertAlive(); this.rendering = true; this.connector?.setRendering(true); }
  stop(): void { this.assertAlive(); this.rendering = false; this.connector?.setRendering(false); }
  clear(): void { this.mutateLive(() => this.core.clear()); }
  resetToNeutral(): void { this.clear(); }
  dispose(): void {
    if (this.disposed) return;
    this.connector?.dispose();
    this.core.free();
    this.playbacks.clear();
    this.current.clear();
    this.sources.clear();
    this.hairObjects.clear();
    this.meshes.length = 0;
    this.meshByName.clear();
    this.bones = {};
    this.liveTargets.clear();
    this.connector = undefined;
    this.inspection = undefined;
    this.boundModel = undefined;
    this.disposed = true;
  }
}

export function createRustEmbodyHostUnbound(config: RustEmbodyHostConfig = {}): Embody { return new Embody(config); }
export async function createRustEmbodyHost(model: Object3D, config: RustEmbodyHostConfig = {}): Promise<Embody> {
  const character = await Embody.create(config);
  try { character.onReady({ model, meshes: config.meshes, referencePose: config.referencePose }); return character; }
  catch (error) { character.dispose(); throw error; }
}
