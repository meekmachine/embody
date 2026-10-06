import {
  AnimationClip, InterpolateDiscrete, InterpolateLinear, LoadingManager,
  Matrix4, Quaternion, QuaternionKeyframeTrack, Texture, TextureLoader,
  Vector3, VectorKeyframeTrack,
} from 'three';
import type { Object3D, SkinnedMesh, Mesh, Material } from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { requireInitializedEmbodyCore } from '@lovelace_lol/embody/wasm';
import { bindModelReferencePose, captureModelReferencePose } from './reference-pose';
import type { ThreeModelReferencePose } from './reference-pose';
import { ThreeModelInspector } from './index';

type Vec3 = [number, number, number];
type Quat = [number, number, number, number];
type RigNode = { id: string; name: string; parent: string | null; translation: Vec3; rotation: Quat; scale: Vec3 };
type Rig = { metersPerUnit: number; nodes: RigNode[]; humanoidBones: Record<string, string> };
type AnimationTrack = { node: string; path: 'rotation' | 'translation' | 'scale'; interpolation: 'STEP' | 'LINEAR'; times: number[]; values: number[] };

/** Validated body-animation intermediate, not a file format. Persist the .vrma GLB bytes. */
export type VrmAnimationDocument = {
  version: 1; name: string; durationSeconds: number; rig: Rig; tracks: AnimationTrack[];
};
export type MixamoVrmAnimationOptions = {
  /** Mixamo FBX generally uses centimeters (0.01); this is explicit, never inferred. */
  metersPerUnit: number;
  /** Authored T reference; omission requires skin bind inverses. Never pass frame zero. */
  referencePose?: ThreeModelReferencePose;
};
export type VrmAnimationTargetOptions = {
  metersPerUnit: number;
  referencePose: ThreeModelReferencePose;
  /** Existing Embody profile; resolved with Rust's humanoid characterization. */
  profile?: unknown;
  /** Explicit VRM role -> unique target bone name, taking precedence over profile. */
  humanoidBones?: Record<string, string>;
  name?: string;
};

const MAX_BYTES = 64 * 1024 * 1024;
const identity = new Matrix4();
const isBone = (node: Object3D) => (node as Object3D & { isBone?: boolean }).isBone || node.type === 'Bone';

function decomposeReference(matrix: Matrix4, name: string) {
  const position = new Vector3(); const rotation = new Quaternion(); const scale = new Vector3();
  if (!matrix.elements.every(Number.isFinite) || Math.abs(matrix.determinant()) < 1e-20) {
    throw new Error(`Invalid reference matrix for ${name}`);
  }
  matrix.decompose(position, rotation, scale);
  const reconstructed = new Matrix4().compose(position, rotation, scale);
  if (matrix.elements.some((v, i) => Math.abs(v - reconstructed.elements[i]) > 1e-5 * Math.max(1, Math.abs(v)))) {
    throw new Error(`Reference ${name} contains shear, which VRMA retargeting does not support`);
  }
  return { translation: position.toArray() as Vec3, rotation: rotation.toArray() as Quat, scale: scale.toArray() as Vec3 };
}

function objectsInModel(model: Object3D) {
  const all: Object3D[] = [];
  model.traverse((node) => all.push(node));
  const needed = new Set<Object3D>([model]);
  for (const bone of all.filter(isBone)) {
    for (let node: Object3D | null = bone; node && node !== model; node = node.parent) needed.add(node);
  }
  const objects = all.filter((node) => needed.has(node));
  if (objects.length > 4096) throw new Error('Animation rig exceeds 4096 nodes');
  const ids = new Map(objects.map((node, i) => [node, String(i)]));
  return { objects, ids };
}

function inspectReference(model: Object3D, referencePose: ThreeModelReferencePose, metersPerUnit: number, includeRoot = false) {
  const bindings = bindModelReferencePose(model, referencePose);
  const { objects, ids } = objectsInModel(model);
  const nodes = objects.map((node) => ({
    id: ids.get(node)!, name: node.name, parent: node === model ? null : ids.get(node.parent!)!,
    // Placement of the model in a scene is not part of its humanoid coordinate system.
    ...decomposeReference(node === model && !includeRoot ? identity : new Matrix4().fromArray(bindings.get(node)!.localMatrix), node.name),
  }));
  return { rig: { metersPerUnit, nodes, humanoidBones: {} } as Rig, objects, ids };
}

function inspectSkinBind(model: Object3D, metersPerUnit: number) {
  if (model.parent) throw new Error('Use an explicit referencePose for a parented source model');
  const initial = captureModelReferencePose(model);
  const initialBindings = bindModelReferencePose(model, initial);
  const { objects, ids } = objectsInModel(model);
  const world = new Map<Object3D, Matrix4>();
  const all: Object3D[] = [];
  model.traverse((node) => all.push(node));
  for (const node of all) {
    const mesh = node as SkinnedMesh;
    if (!mesh.isSkinnedMesh) continue;
    const { bones, boneInverses } = mesh.skeleton;
    if (bones.length !== boneInverses.length) throw new Error('Invalid skin bind inverse count');
    bones.forEach((bone, index) => {
      const inverse = boneInverses[index];
      if (Math.abs(inverse.determinant()) < 1e-20) throw new Error(`Singular bind matrix for ${bone.name}`);
      const bind = inverse.clone().invert();
      const prior = world.get(bone);
      if (prior && prior.elements.some((value, i) => Math.abs(value - bind.elements[i]) > 1e-4)) {
        throw new Error(`Conflicting skin bind matrices for ${bone.name}`);
      }
      world.set(bone, bind);
    });
  }
  const nodes = objects.map((node) => {
    if (isBone(node) && !world.has(node)) {
      throw new Error(`No skin bind reference for ${node.name}; supply an explicit authored T-pose reference`);
    }
    const nodeWorld = world.get(node) ?? new Matrix4().fromArray(initialBindings.get(node)!.worldMatrix);
    const parentWorld = node.parent
      ? world.get(node.parent) ?? new Matrix4().fromArray(initialBindings.get(node.parent)!.worldMatrix)
      : identity;
    const local = parentWorld.clone().invert().multiply(nodeWorld);
    return { id: ids.get(node)!, name: node.name, parent: node === model ? null : ids.get(node.parent!)!, ...decomposeReference(local, node.name) };
  });
  return { rig: { metersPerUnit, nodes, humanoidBones: {} } as Rig, objects, ids };
}

function uniqueBone(objects: Object3D[], name: string) {
  const matches = objects.filter((node) => isBone(node) && (node.name === name || node.uuid === name));
  if (matches.length !== 1) throw new Error(`Animation bone ${name} must resolve uniquely (found ${matches.length})`);
  return matches[0];
}

/** Pure conversion with borrowed native objects: no mixer, scene mutation, loading or disposal. */
export function convertMixamoToVrmAnimation(source: Object3D, clip: AnimationClip, options: MixamoVrmAnimationOptions): Uint8Array {
  const core = requireInitializedEmbodyCore();
  const { rig, objects, ids } = options.referencePose
    ? inspectReference(source, options.referencePose, options.metersPerUnit, true)
    : inspectSkinBind(source, options.metersPerUnit);
  const tracks: AnimationTrack[] = clip.tracks.map((track) => {
    // FBXLoader creates direct bone property tracks. Avoid PropertyBinding's fuzzy
    // name lookup and reject arbitrary scene/morph/indexed targets explicitly.
    const match = /^(.*)\.(quaternion|position|scale)$/.exec(track.name);
    if (!match) throw new Error(`Unsupported Mixamo track ${track.name}`);
    const bone = uniqueBone(objects, match[1]);
    const interpolation = track.getInterpolation();
    if (interpolation !== InterpolateLinear && interpolation !== InterpolateDiscrete) {
      throw new Error(`Unsupported interpolation on ${track.name}`);
    }
    return { node: ids.get(bone)!, path: match[2] === 'quaternion' ? 'rotation' : match[2] === 'position' ? 'translation' : 'scale',
      interpolation: interpolation === InterpolateDiscrete ? 'STEP' : 'LINEAR', times: Array.from(track.times), values: Array.from(track.values) };
  });
  const normalized = core.normalize_mixamo_animation(JSON.stringify({ version: 1, name: clip.name, durationSeconds: clip.duration, rig, tracks }));
  return core.encode_vrma_animation(normalized);
}

/** Validates embedded binary/accessors, humanoid hierarchy, reference and supported channels. */
export function inspectVrmAnimation(bytes: Uint8Array): VrmAnimationDocument {
  if (bytes.byteLength > MAX_BYTES) throw new Error('VRMA exceeds 64 MiB');
  return JSON.parse(requireInitializedEmbodyCore().decode_vrma_animation(bytes)) as VrmAnimationDocument;
}

/** Builds native target-local tracks. The caller owns mixer scheduling and blending. */
export function createAnimationClipFromVrmAnimation(bytes: Uint8Array, target: Object3D, options: VrmAnimationTargetOptions): AnimationClip {
  const core = requireInitializedEmbodyCore();
  const document = inspectVrmAnimation(bytes);
  const { rig, objects, ids } = inspectReference(target, options.referencePose, options.metersPerUnit);
  let humanoidBones = options.humanoidBones;
  if (!humanoidBones) {
    if (!options.profile) throw new Error('VRMA target requires a characterized profile or explicit humanoidBones');
    const inspection = new ThreeModelInspector().inspectModel(target, { referencePose: options.referencePose });
    const result = JSON.parse(core.validate_humanoid_characterization(JSON.stringify(options.profile), JSON.stringify(inspection.descriptor))) as {
      valid: boolean; errors: string[]; roles: Record<string, { boneName: string }>;
    };
    if (!result.valid) throw new Error(`Cannot characterize VRMA target: ${result.errors.join('; ')}`);
    humanoidBones = Object.fromEntries(Object.entries(result.roles).filter(([role]) => role !== 'leftEye' && role !== 'rightEye').map(([role, binding]) => [role, binding.boneName]));
  }
  for (const [role, name] of Object.entries(humanoidBones)) rig.humanoidBones[role] = ids.get(uniqueBone(objects, name))!;
  const retargeted = JSON.parse(core.retarget_vrma_animation(JSON.stringify(document), JSON.stringify(rig))) as VrmAnimationDocument;
  const byId = new Map(objects.map((node) => [ids.get(node)!, node]));
  const tracks = retargeted.tracks.map((track) => {
    const node = byId.get(track.node);
    if (!node) throw new Error(`Retargeted node ${track.node} is not in the target model`);
    const interpolation = track.interpolation === 'STEP' ? InterpolateDiscrete : InterpolateLinear;
    return track.path === 'rotation'
      ? new QuaternionKeyframeTrack(`${node.uuid}.quaternion`, track.times, track.values, interpolation)
      : new VectorKeyframeTrack(`${node.uuid}.position`, track.times, track.values, interpolation);
  });
  return new AnimationClip(options.name ?? document.name, retargeted.durationSeconds, tracks);
}

/** Browser FBX boundary: textures are never fetched; temporary parser objects are released. */
export function convertMixamoFbxToVrmAnimations(bytes: ArrayBuffer, options: { metersPerUnit: number }): Array<{ name: string; bytes: Uint8Array }> {
  requireInitializedEmbodyCore();
  if (!bytes.byteLength || bytes.byteLength > MAX_BYTES) throw new Error('FBX must be between 1 byte and 64 MiB');
  const textures = new Set<Texture>();
  class AnimationTextureLoader extends TextureLoader {
    override load(url: string): Texture {
      // FBXLoader may create blob URLs for embedded images; consume no image data.
      if (url.startsWith('blob:')) URL.revokeObjectURL(url);
      const texture = new Texture(); textures.add(texture); return texture;
    }
  }
  const manager = new LoadingManager();
  manager.addHandler(/.*/, new AnimationTextureLoader(manager));
  manager.setURLModifier(() => { throw new Error('External FBX resources are not allowed for animation conversion'); });
  let source: Object3D | undefined;
  try {
    source = new FBXLoader(manager).parse(bytes, '');
    if (!source.animations.length) throw new Error('FBX has no animation clips');
    let hasSkin = false;
    source.traverse((node) => { if ((node as SkinnedMesh).isSkinnedMesh) hasSkin = true; });
    // FBXLoader has not played any animation. For animation-only exports the
    // authored default transforms are the explicit reference, validated in Rust.
    const referencePose = hasSkin ? undefined : captureModelReferencePose(source);
    return source.animations.map((clip) => ({ name: clip.name, bytes: convertMixamoToVrmAnimation(source!, clip, { ...options, referencePose }) }));
  } finally {
    const materials = new Set<Material>();
    source?.traverse((node) => {
      const mesh = node as Mesh;
      mesh.geometry?.dispose();
      if (mesh.material) for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) materials.add(material);
      (node as SkinnedMesh).skeleton?.dispose();
    });
    for (const material of materials) material.dispose();
    for (const texture of textures) texture.dispose();
  }
}
