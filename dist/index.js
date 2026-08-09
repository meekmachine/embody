import { NoBlending, MultiplyBlending, SubtractiveBlending, AdditiveBlending, NormalBlending, Box3, MathUtils, Mesh, PlaneGeometry, ShadowMaterial, HemisphereLight, DirectionalLight, PMREMGenerator, WebGLRenderer, PCFSoftShadowMap, Scene, Color, PerspectiveCamera, NumberKeyframeTrack, QuaternionKeyframeTrack, VectorKeyframeTrack, AnimationClip, InterpolateDiscrete, BufferAttribute, SRGBColorSpace, ACESFilmicToneMapping, PropertyBinding } from 'three';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
var draco = null;
var dracoPath = "";
var gltfLoader = null;
var gltfLoaderUsesDraco = false;
var fbxLoader = null;
var getGltfLoader = (dracoDecoderPath) => {
  const wantsDraco = typeof dracoDecoderPath === "string" && dracoDecoderPath.length > 0;
  const normalizedPath = wantsDraco ? dracoDecoderPath.endsWith("/") ? dracoDecoderPath : `${dracoDecoderPath}/` : "";
  if (!gltfLoader || gltfLoaderUsesDraco !== wantsDraco || wantsDraco && normalizedPath !== dracoPath) {
    draco?.dispose();
    draco = null;
    dracoPath = normalizedPath;
    gltfLoaderUsesDraco = wantsDraco;
    gltfLoader = new GLTFLoader();
    if (wantsDraco) {
      draco = new DRACOLoader().setDecoderPath(normalizedPath).setDecoderConfig({ type: "wasm" });
      gltfLoader.setDRACOLoader(draco);
    }
  }
  return gltfLoader;
};
var prepare = (model, castShadows = true) => {
  const meshes = [];
  model.traverse((object) => {
    if (!object.isMesh) return;
    if (castShadows) object.castShadow = true;
    if (object.morphTargetInfluences?.length) meshes.push(object);
  });
  return meshes;
};
var progress = (listener) => {
  let last = -1;
  return (event) => {
    if (!listener || !event.lengthComputable) return;
    const next = Math.min(100, Math.max(0, Math.round(event.loaded / event.total * 100)));
    if (next !== last) {
      last = next;
      listener(next);
    }
  };
};
function applyCharacterModelTransform(model, value = {}) {
  if (value.modelOffset) model.position.set(value.modelOffset.x ?? 0, value.modelOffset.y ?? 0, value.modelOffset.z ?? 0);
  if (value.modelRotation) model.rotation.set(...["x", "y", "z"].map((axis) => (value.modelRotation?.[axis] ?? 0) * Math.PI / 180));
  if (Number.isFinite(value.modelScale) && (value.modelScale ?? 0) > 0) model.scale.setScalar(value.modelScale);
  if (Number.isFinite(value.modelGroundClearance)) {
    model.updateMatrixWorld(true);
    const min = new Box3().setFromObject(model).min.y;
    if (Number.isFinite(min) && min < value.modelGroundClearance) model.position.y += value.modelGroundClearance - min;
  }
}
function disposeCharacterModel(scene, model) {
  scene?.remove(model);
  model.traverse((object) => {
    object.geometry?.dispose?.();
    for (const material of object.material ? Array.isArray(object.material) ? object.material : [object.material] : []) {
      for (const value of Object.values(material)) if (value?.isTexture) value.dispose?.();
      material.dispose?.();
    }
  });
}
function loadCharacterModel(url, options = {}) {
  const done = (model, animations, gltf) => ({ model, meshes: prepare(model, options.castShadows), animations, gltf });
  if (/\.fbx(?:\?|$)/i.test(url)) {
    fbxLoader ?? (fbxLoader = new FBXLoader());
    return new Promise((resolve, reject) => fbxLoader.load(url, (model) => resolve(done(model, model.animations ?? [], null)), progress(options.onProgress), reject));
  }
  const loader = getGltfLoader(options.dracoDecoderPath);
  return new Promise((resolve, reject) => loader.load(url, (gltf) => resolve(done(gltf.scene, gltf.animations ?? [], gltf)), progress(options.onProgress), reject));
}
function parseCharacterModel(data, resourcePath = "", options = {}) {
  const loader = getGltfLoader(options.dracoDecoderPath);
  return new Promise((resolve, reject) => loader.parse(data, resourcePath, (gltf) => resolve({ model: gltf.scene, meshes: prepare(gltf.scene, options.castShadows), animations: gltf.animations ?? [], gltf }), reject));
}
var DEFAULT_CHARACTER_LIGHTING_PRESETS = {
  cleanStudio: { id: "cleanStudio", label: "Soft Studio", settings: { envMapEnabled: true, environmentIntensity: 0.24, environmentBlur: 0.04, exposure: 1.08, ambientIntensity: 0.32, keyIntensity: 0.52, fillIntensity: 0.18, rimIntensity: 0.08, shadowOpacity: 0.22 } },
  softFill: { id: "softFill", label: "Soft Fill", settings: { envMapEnabled: true, environmentIntensity: 0.3, environmentBlur: 0.04, exposure: 1.1, ambientIntensity: 0.38, keyIntensity: 0.44, fillIntensity: 0.24, rimIntensity: 0.1, shadowOpacity: 0.18 } },
  inspection: { id: "inspection", label: "Inspection", settings: { envMapEnabled: true, environmentIntensity: 0.45, environmentBlur: 0.035, exposure: 1.18, ambientIntensity: 0.48, keyIntensity: 0.58, fillIntensity: 0.32, rimIntensity: 0.14, shadowOpacity: 0.12 } },
  contrast: { id: "contrast", label: "Contrast", settings: { envMapEnabled: true, environmentIntensity: 0.2, environmentBlur: 0.035, exposure: 1.08, ambientIntensity: 0.25, keyIntensity: 0.7, fillIntensity: 0.12, rimIntensity: 0.22, shadowOpacity: 0.28 } }
};
var DEFAULT_CHARACTER_LIGHTING_PRESET_ID = "cleanStudio";
var DEFAULT_CHARACTER_LIGHTING_PRESET_IDS = Object.keys(DEFAULT_CHARACTER_LIGHTING_PRESETS);
var DEFAULT_CHARACTER_LIGHTING_SETTINGS = { ...DEFAULT_CHARACTER_LIGHTING_PRESETS.cleanStudio.settings };
var CHARACTER_SCENE_TYPES = {
  studio: { id: "studio", label: "Studio", description: "Transparent background, soft studio lighting, ground shadow.", background: null, lightingPreset: "cleanStudio", shadowPlane: true },
  showcase: { id: "showcase", label: "Showcase", description: "Dark backdrop with contrasty key/rim lighting for presentation shots.", background: 1053206, lightingPreset: "contrast", shadowPlane: true },
  inspection: { id: "inspection", label: "Inspection", description: "Bright, even lighting on a light backdrop for close-up review.", background: 15264493, lightingPreset: "inspection", shadowPlane: true },
  void: { id: "void", label: "Void", description: "Transparent background, soft fill lighting, no ground shadow.", background: null, lightingPreset: "softFill", shadowPlane: false }
};
var CHARACTER_SCENE_TYPE_IDS = Object.keys(CHARACTER_SCENE_TYPES);
var DEFAULT_CHARACTER_SCENE_TYPE_ID = "studio";
var finite = (value, min, max, fallback) => {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? MathUtils.clamp(number, min, max) : fallback;
};
var normalize = (value) => ({
  envMapEnabled: typeof value.envMapEnabled === "boolean" ? value.envMapEnabled : DEFAULT_CHARACTER_LIGHTING_SETTINGS.envMapEnabled,
  environmentIntensity: finite(value.environmentIntensity, 0, 1.5, DEFAULT_CHARACTER_LIGHTING_SETTINGS.environmentIntensity),
  environmentBlur: finite(value.environmentBlur, 0, 0.04, DEFAULT_CHARACTER_LIGHTING_SETTINGS.environmentBlur),
  exposure: finite(value.exposure, 0.6, 2.2, DEFAULT_CHARACTER_LIGHTING_SETTINGS.exposure),
  ambientIntensity: finite(value.ambientIntensity, 0, 1.4, DEFAULT_CHARACTER_LIGHTING_SETTINGS.ambientIntensity),
  keyIntensity: finite(value.keyIntensity, 0, 2.2, DEFAULT_CHARACTER_LIGHTING_SETTINGS.keyIntensity),
  fillIntensity: finite(value.fillIntensity, 0, 1.6, DEFAULT_CHARACTER_LIGHTING_SETTINGS.fillIntensity),
  rimIntensity: finite(value.rimIntensity, 0, 1.6, DEFAULT_CHARACTER_LIGHTING_SETTINGS.rimIntensity),
  shadowOpacity: finite(value.shadowOpacity, 0, 0.5, DEFAULT_CHARACTER_LIGHTING_SETTINGS.shadowOpacity)
});
var normalizeDefaultCharacterLightingSettings = (value) => value && typeof value === "object" && !Array.isArray(value) ? normalize(value) : null;
function createShadowPlane(scene, options = {}) {
  const plane = new Mesh(new PlaneGeometry(options.size ?? 20, options.size ?? 20), new ShadowMaterial({ opacity: options.opacity ?? 0.3 }));
  plane.rotation.x = -Math.PI / 2;
  plane.position.y = options.yPosition ?? -0.01;
  plane.receiveShadow = true;
  plane.name = "shadowPlane";
  scene.add(plane);
  return plane;
}
function createDefaultCharacterLighting(scene, renderer, initial = {}) {
  const ambient = new HemisphereLight(16251903, 7041664, 0);
  const key = new DirectionalLight(16776180, 0);
  const fill = new DirectionalLight(15266047, 0);
  const rim = new DirectionalLight(14543103, 0);
  ambient.name = "embodyCharacterAmbientHemisphereLight";
  ambient.position.set(0, 8, 0);
  key.name = "embodyCharacterKeyLight";
  key.position.set(4.5, 7.5, 6.2);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  Object.assign(key.shadow.camera, { near: 0.5, far: 50, left: -10, right: 10, top: 10, bottom: -10 });
  key.shadow.bias = -1e-4;
  key.shadow.radius = 4;
  fill.name = "embodyCharacterFillLight";
  fill.position.set(-5.5, 4.2, 4.5);
  rim.name = "embodyCharacterRimLight";
  rim.position.set(-3.5, 4.8, -5.4);
  scene.add(ambient, key, fill, rim);
  const pmrem = new PMREMGenerator(renderer);
  const listeners = /* @__PURE__ */ new Set();
  let environment = null;
  let settings = normalize({ ...DEFAULT_CHARACTER_LIGHTING_SETTINGS, ...initial });
  const rebuild = () => {
    environment?.dispose();
    environment = null;
    if (!settings.envMapEnabled) {
      scene.environment = null;
      return;
    }
    const room = new RoomEnvironment();
    try {
      environment = pmrem.fromScene(room, settings.environmentBlur);
    } finally {
      room.dispose();
    }
    scene.environment = environment.texture;
  };
  const apply = () => {
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = settings.exposure;
    scene.environmentIntensity = settings.envMapEnabled ? settings.environmentIntensity : 0;
    ambient.intensity = settings.ambientIntensity;
    key.intensity = settings.keyIntensity;
    fill.intensity = settings.fillIntensity;
    rim.intensity = settings.rimIntensity;
    const plane = scene.getObjectByName("shadowPlane");
    for (const material of plane ? Array.isArray(plane.material) ? plane.material : [plane.material] : []) if (material instanceof ShadowMaterial) material.opacity = settings.shadowOpacity;
  };
  rebuild();
  apply();
  const setSettings = (patch) => {
    const previous = settings;
    settings = normalize({ ...settings, ...patch });
    if (previous.envMapEnabled !== settings.envMapEnabled || previous.environmentBlur !== settings.environmentBlur) rebuild();
    apply();
    listeners.forEach((listener) => listener({ ...settings }));
    return { ...settings };
  };
  return {
    getSettings: () => ({ ...settings }),
    getEnvironmentTexture: () => environment?.texture ?? null,
    setSettings,
    setPreset: (id) => setSettings(DEFAULT_CHARACTER_LIGHTING_PRESETS[id]?.settings ?? {}),
    subscribe: (listener) => {
      listeners.add(listener);
      listener({ ...settings });
      return () => {
        listeners.delete(listener);
      };
    },
    dispose: () => {
      listeners.clear();
      environment?.dispose();
      pmrem.dispose();
      scene.environment = null;
      scene.remove(ambient, key, fill, rim);
    }
  };
}
function createDefaultCharacterScene(container, options = {}) {
  const sceneType = CHARACTER_SCENE_TYPES[options.type] ?? CHARACTER_SCENE_TYPES.studio;
  const width = Math.max(1, container.clientWidth || globalThis.innerWidth || 1);
  const height = Math.max(1, container.clientHeight || globalThis.innerHeight || 1);
  const renderer = new WebGLRenderer({ alpha: true, antialias: true, powerPreference: "high-performance" });
  const ratio = () => Math.min(globalThis.devicePixelRatio || 1, options.pixelRatioCap ?? 1.5);
  renderer.setPixelRatio(ratio());
  renderer.setSize(width, height, true);
  renderer.shadowMap.enabled = options.shadows ?? true;
  renderer.shadowMap.type = PCFSoftShadowMap;
  container.appendChild(renderer.domElement);
  Object.assign(renderer.domElement.style, { display: "block", width: "100%", height: "100%" });
  const scene = new Scene();
  const background = options.background === void 0 ? sceneType.background : options.background;
  scene.background = background == null ? null : new Color(background);
  const camera = new PerspectiveCamera(options.cameraFov ?? 45, width / height, 0.1, 1e3);
  const preset = DEFAULT_CHARACTER_LIGHTING_PRESETS[options.lightingPreset ?? sceneType.lightingPreset]?.settings ?? DEFAULT_CHARACTER_LIGHTING_SETTINGS;
  const lighting = createDefaultCharacterLighting(scene, renderer, { ...preset, ...options.lighting });
  const shadowPlane = options.shadowPlane ?? sceneType.shadowPlane ? createShadowPlane(scene, { opacity: lighting.getSettings().shadowOpacity }) : null;
  const resize = () => {
    const w = Math.max(1, container.clientWidth || globalThis.innerWidth || 1);
    const h = Math.max(1, container.clientHeight || globalThis.innerHeight || 1);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(ratio());
    renderer.setSize(w, h, false);
  };
  if (options.manageResize !== false) globalThis.addEventListener?.("resize", resize);
  return { container, scene, renderer, camera, lighting, shadowPlane, sceneType: sceneType.id, ownsScene: true, resize, dispose: () => {
    if (options.manageResize !== false) globalThis.removeEventListener?.("resize", resize);
    lighting.dispose();
    if (shadowPlane) {
      scene.remove(shadowPlane);
      shadowPlane.geometry.dispose();
      (Array.isArray(shadowPlane.material) ? shadowPlane.material : [shadowPlane.material]).forEach((material) => material.dispose());
    }
    if (renderer.domElement.parentElement === container) container.removeChild(renderer.domElement);
    renderer.dispose();
  } };
}

// three/index.ts
var THREE_BLENDING_MODES = {
  Normal: NormalBlending,
  Additive: AdditiveBlending,
  Subtractive: SubtractiveBlending,
  Multiply: MultiplyBlending,
  None: NoBlending
};
var MORPH_ATTRIBUTE_SEMANTICS = ["position", "normal", "tangent", "color"];
var createNeutralMorphAttribute = (geometry, semantic, name) => {
  const base = geometry.getAttribute(semantic);
  if (!base) throw new Error(`Cannot create ${semantic} morph data without a base attribute`);
  const values = new Float32Array(base.count * base.itemSize);
  if (!geometry.morphTargetsRelative) {
    for (let vertexIndex = 0; vertexIndex < base.count; vertexIndex += 1) {
      for (let component = 0; component < base.itemSize; component += 1) {
        values[vertexIndex * base.itemSize + component] = base.getComponent(vertexIndex, component);
      }
    }
  }
  const attribute = new BufferAttribute(values, base.itemSize);
  attribute.name = name;
  return attribute;
};
var transform = (obj) => ({
  position: { x: obj.position.x, y: obj.position.y, z: obj.position.z },
  rotation: { x: obj.quaternion.x, y: obj.quaternion.y, z: obj.quaternion.z, w: obj.quaternion.w },
  scale: { x: obj.scale.x, y: obj.scale.y, z: obj.scale.z }
});
var snapshot = (obj) => ({
  obj,
  basePos: { x: obj.position.x, y: obj.position.y, z: obj.position.z },
  baseQuat: obj.quaternion.clone(),
  baseEuler: { x: obj.rotation.x, y: obj.rotation.y, z: obj.rotation.z, order: obj.rotation.order }
});
var boneDepth = (obj) => {
  let depth = 0;
  let parent = obj.parent;
  while (parent) {
    if (parent.isBone || parent.type === "Bone") depth += 1;
    parent = parent.parent;
  }
  return depth;
};
var morphEntries = (mesh) => {
  const dictionary = mesh.morphTargetDictionary ?? mesh.geometry.morphTargetDictionary;
  if (dictionary) {
    return Object.entries(dictionary).map(([name, index]) => ({ name, index })).sort((left, right) => left.index - right.index);
  }
  return (mesh.morphTargetInfluences ?? []).map((_, index) => ({ name: `morph_${index}`, index }));
};
var ThreeModelInspector = class {
  inspectModel(model, options = {}) {
    const objects = [];
    const allMeshes = [];
    const boneObjects = [];
    model.traverse((obj) => {
      objects.push(obj);
      if (obj.isMesh) allMeshes.push(obj);
      if (obj.isBone || obj.type === "Bone") boneObjects.push(obj);
    });
    const inputMeshes = options.meshes ?? [];
    const morphMeshes = Array.from(/* @__PURE__ */ new Set([...inputMeshes, ...allMeshes.filter((mesh) => morphEntries(mesh).length > 0)]));
    const meshByName = new Map(allMeshes.filter((mesh) => mesh.name).map((mesh) => [mesh.name, mesh]));
    const meshBindings = new Map(allMeshes.map((mesh, index) => [index + 1, mesh]));
    const boneBindings = new Map(boneObjects.map((bone, index) => [index + 1, bone]));
    const objectBindings = new Map(objects.map((object, index) => [index + 1, object]));
    const meshIds = new Map(Array.from(meshBindings, ([id, mesh]) => [mesh, id]));
    const boneIds = new Map(Array.from(boneBindings, ([id, bone]) => [bone, id]));
    const objectIds = new Map(Array.from(objectBindings, ([id, object]) => [object, id]));
    const morphBindings = /* @__PURE__ */ new Map();
    const morphTargets = [];
    const morphIdsByMesh = /* @__PURE__ */ new Map();
    let morphId = 1;
    for (const mesh of allMeshes) {
      const ids = [];
      for (const entry of morphEntries(mesh)) {
        ids.push(morphId);
        morphBindings.set(morphId, { mesh, index: entry.index });
        morphTargets.push({
          id: morphId,
          meshId: meshIds.get(mesh),
          name: entry.name,
          hostIndex: entry.index,
          initialValue: mesh.morphTargetInfluences?.[entry.index] ?? 0
        });
        morphId += 1;
      }
      morphIdsByMesh.set(mesh, ids);
    }
    const bones = {};
    for (const bone of boneObjects) {
      if (bone.name) bones[bone.name] = snapshot(bone);
    }
    const profile = options.profile;
    if (profile?.boneNodes) {
      for (const [key, base] of Object.entries(profile.boneNodes)) {
        const prefix = profile.bonePrefix ?? "";
        const suffix = profile.boneSuffix ?? "";
        const name = `${base.startsWith(prefix) ? "" : prefix}${base}${base.endsWith(suffix) ? "" : suffix}`;
        const object = model.getObjectByName(name) ?? model.getObjectByName(base);
        if (object) bones[key] = bones[object.name] ?? snapshot(object);
      }
    }
    return {
      descriptor: {
        id: model.uuid,
        name: model.name || void 0,
        meshes: allMeshes.map((mesh) => ({
          id: meshIds.get(mesh),
          name: mesh.name,
          morphTargetIds: morphIdsByMesh.get(mesh) ?? [],
          visible: mesh.visible
        })),
        morphTargets,
        bones: boneObjects.map((bone) => {
          const world = bone.getWorldPosition(bone.position.clone());
          const parent = bone.parent && (bone.parent.isBone || bone.parent.type === "Bone") ? bone.parent.name || null : null;
          return {
            id: boneIds.get(bone),
            name: bone.name,
            parentName: parent,
            worldPosition: { x: world.x, y: world.y, z: world.z },
            depth: boneDepth(bone),
            restTransform: transform(bone)
          };
        }),
        objects: objects.map((object) => ({
          id: objectIds.get(object),
          name: object.name,
          isBone: !!(object.isBone || object.type === "Bone"),
          isCamera: !!object.isCamera,
          restTransform: transform(object)
        }))
      },
      meshByName,
      allMeshes,
      morphMeshes,
      bones,
      meshBindings,
      morphBindings,
      boneBindings,
      objectBindings
    };
  }
};
var findTrackTarget = (model, track) => {
  try {
    const parsed = PropertyBinding.parseTrackName(track.name);
    const key = parsed.objectName === "bones" && parsed.objectIndex ? String(parsed.objectIndex) : parsed.nodeName;
    const object = key ? model.getObjectByProperty("uuid", key) ?? PropertyBinding.findNode(model, key) : model;
    return { parsed, object };
  } catch {
    return null;
  }
};
function createAnimationClipFromClipIR(clip, inspection) {
  const tracks = [];
  for (const track of clip.tracks ?? []) {
    const kind = track.target?.kind;
    const times = Array.from(track.times ?? []);
    const values = Array.from(track.values ?? []);
    if (!times.length || !values.length) continue;
    if (kind === "morphTarget") {
      const binding = inspection.morphBindings.get(Number(track.target.morphTargetId));
      if (!binding?.mesh) continue;
      const trackName = `${binding.mesh.uuid}.morphTargetInfluences[${binding.index}]`;
      tracks.push(new NumberKeyframeTrack(trackName, times, values));
      continue;
    }
    if (kind === "boneTransform" || kind === "objectTransform") {
      const object = kind === "boneTransform" ? inspection.boneBindings.get(Number(track.target.boneId)) : inspection.objectBindings.get(Number(track.target.objectId));
      if (!object) continue;
      const property = track.target.property ?? "rotation";
      if (property === "rotation" || property === "quaternion") {
        tracks.push(new QuaternionKeyframeTrack(`${object.uuid}.quaternion`, times, values));
      } else if (property === "position") {
        tracks.push(new VectorKeyframeTrack(`${object.uuid}.position`, times, values));
      } else if (property === "scale") {
        tracks.push(new VectorKeyframeTrack(`${object.uuid}.scale`, times, values));
      }
      continue;
    }
    if (kind === "meshVisibility") {
      const mesh = inspection.meshBindings.get(Number(track.target.meshId));
      if (!mesh) continue;
      tracks.push(new NumberKeyframeTrack(`${mesh.uuid}.visible`, times, values));
    }
  }
  const duration = Number.isFinite(clip.durationSeconds) ? Number(clip.durationSeconds) : -1;
  return new AnimationClip(clip.name || "clip", duration, tracks);
}
function serializeAnimationClips(model, clips, inspection) {
  const meshIds = new Map(Array.from(inspection.meshBindings, ([id, mesh]) => [mesh, id]));
  const boneIds = new Map(Array.from(inspection.boneBindings, ([id, bone]) => [bone, id]));
  const objectIds = new Map(Array.from(inspection.objectBindings, ([id, object]) => [object, id]));
  return clips.map((clip) => {
    const tracks = [];
    const channelKinds = /* @__PURE__ */ new Map();
    const channelId = (kind) => {
      const existing = channelKinds.get(kind);
      if (existing) return existing;
      const id = channelKinds.size + 1;
      channelKinds.set(kind, id);
      return id;
    };
    clip.tracks.forEach((track, index) => {
      const found = findTrackTarget(model, track);
      if (!found?.object) return;
      const { parsed, object } = found;
      let target = null;
      const property = parsed.propertyName;
      if ((property === "morphTargetInfluences" || property === "weights") && object.isMesh) {
        const mesh = object;
        const requested = parsed.propertyIndex;
        const indexValue = typeof requested === "number" ? requested : Number.isFinite(Number(requested)) ? Number(requested) : mesh.morphTargetDictionary?.[String(requested)];
        const binding = Array.from(inspection.morphBindings).find(([, entry]) => entry.mesh === mesh && entry.index === indexValue);
        if (binding) target = { kind: "morphTarget", meshId: meshIds.get(mesh), morphTargetId: binding[0] };
      } else if (property === "visible" && object.isMesh) {
        target = { kind: "meshVisibility", meshId: meshIds.get(object) };
      } else {
        const transformProperty = property === "quaternion" || property === "rotation" ? "rotation" : property === "position" ? "position" : property === "scale" ? "scale" : null;
        if (transformProperty) {
          const boneId = boneIds.get(object);
          target = boneId ? { kind: "boneTransform", boneId, property: transformProperty } : { kind: "objectTransform", objectId: objectIds.get(object), property: transformProperty };
        }
      }
      if (!target) return;
      const kind = target.kind === "morphTarget" ? "face" : target.kind === "boneTransform" ? "body" : "scene";
      const size = track.getValueSize();
      tracks.push({
        id: index + 1,
        channelId: channelId(kind),
        target,
        valueType: size === 4 ? "quat" : size === 3 ? "vec3" : "scalar",
        times: Array.from(track.times),
        values: Array.from(track.values),
        interpolation: track.getInterpolation() === InterpolateDiscrete ? "step" : "linear",
        sourceName: track.name
      });
    });
    return {
      name: clip.name,
      durationSeconds: clip.duration,
      channels: Array.from(channelKinds, ([kind, id]) => ({ id, kind, name: kind })),
      tracks
    };
  });
}
var materials = (value) => value ? Array.isArray(value) ? value : [value] : [];
var ThreeFrameApplier = class {
  constructor() {
    __publicField(this, "meshes", /* @__PURE__ */ new Map());
    __publicField(this, "morphs", /* @__PURE__ */ new Map());
    __publicField(this, "bones", /* @__PURE__ */ new Map());
    __publicField(this, "objects", /* @__PURE__ */ new Map());
    __publicField(this, "originalEmissive", /* @__PURE__ */ new Map());
  }
  setBindings(inspection) {
    this.meshes = new Map(inspection.meshBindings);
    this.morphs = new Map(inspection.morphBindings);
    this.bones = new Map(inspection.boneBindings);
    this.objects = new Map(inspection.objectBindings);
  }
  applyPackedMorphFrameDelta(values, stride = 4) {
    for (let offset = 0; offset + stride <= values.length; offset += stride) {
      const binding = this.morphs.get(values[offset + 1]);
      if (binding?.mesh.morphTargetInfluences) {
        binding.mesh.morphTargetInfluences[binding.index] = values[offset + 2] ?? 0;
      }
    }
  }
  applyPackedBoneFrameDelta(values, stride = 9) {
    for (let offset = 0; offset + stride <= values.length; offset += stride) {
      const bone = this.bones.get(values[offset]);
      if (!bone) continue;
      const flags = values[offset + 8] ?? 0;
      if (flags & 1) bone.position.set(values[offset + 1], values[offset + 2], values[offset + 3]);
      if (flags & 2) bone.quaternion.set(values[offset + 4], values[offset + 5], values[offset + 6], values[offset + 7]).normalize();
      bone.updateMatrixWorld(false);
    }
  }
  applySceneFrame(frame) {
    const value = typeof frame === "string" ? JSON.parse(frame) : frame;
    for (const write of value.boneScales ?? []) this.bones.get(write.boneId)?.scale.fromArray(write.scale);
    for (const write of value.objects ?? []) {
      const object = this.objects.get(write.objectId);
      if (!object) continue;
      if (write.position) object.position.fromArray(write.position);
      if (write.rotation) object.quaternion.fromArray(write.rotation).normalize();
      if (write.scale) object.scale.fromArray(write.scale);
      object.updateMatrixWorld(false);
    }
    for (const write of value.meshes ?? []) {
      const mesh = this.meshes.get(write.meshId);
      if (mesh) mesh.visible = write.visible;
    }
  }
  applyMeshMaterialConfigs(root, configs) {
    root.traverse((object) => {
      if (object.isMesh && object.name && configs[object.name]?.material) {
        this.applyMaterial(object, configs[object.name].material);
      }
    });
  }
  getMeshMaterialConfig(root, name) {
    let result = null;
    this.visitMesh(root, name, (mesh) => {
      const material = materials(mesh.material)[0];
      if (!material) return;
      const blending = Object.entries(THREE_BLENDING_MODES).find(([, value]) => value === material.blending)?.[0] ?? "Normal";
      result = { renderOrder: mesh.renderOrder, transparent: material.transparent, opacity: material.opacity, depthWrite: material.depthWrite, depthTest: material.depthTest, blending };
    });
    return result;
  }
  setMeshMaterialConfig(root, name, config) {
    this.visitMesh(root, name, (mesh) => this.applyMaterial(mesh, config));
  }
  setMeshVisible(root, name, visible) {
    this.visitMesh(root, name, (mesh) => {
      mesh.visible = visible;
    });
  }
  highlightMesh(root, name, color = 65535, intensity = 0.5) {
    root.traverse((object) => {
      if (!object.isMesh) return;
      for (const material of materials(object.material)) {
        if (!material.emissive) continue;
        const key = `${object.uuid}:${material.uuid}`;
        if (name === object.name) {
          if (!this.originalEmissive.has(key)) this.originalEmissive.set(key, { color: material.emissive.getHex(), intensity: material.emissiveIntensity ?? 0 });
          material.emissive.setHex(color);
          material.emissiveIntensity = intensity;
        } else {
          const original = this.originalEmissive.get(key);
          if (original) {
            material.emissive.setHex(original.color);
            material.emissiveIntensity = original.intensity;
          }
        }
      }
    });
  }
  applyHairAppearance(meshes, appearance) {
    for (const mesh of meshes) {
      for (const material of materials(mesh.material)) {
        if (appearance.baseColor && material.color) material.color.set(appearance.baseColor);
        if (appearance.emissive && material.emissive) material.emissive.set(appearance.emissive);
        if (typeof appearance.emissiveIntensity === "number") material.emissiveIntensity = appearance.emissiveIntensity;
        material.needsUpdate = true;
      }
    }
  }
  addMorphTarget(root, target, options = {}) {
    return this.addMorphTargets(root, [target], options)[`${target.meshName}:${target.name}`];
  }
  addMorphTargets(root, targets, options = {}) {
    if (targets.length === 0) return {};
    const stages = /* @__PURE__ */ new Map();
    const result = {};
    const batchKeys = /* @__PURE__ */ new Set();
    try {
      for (const target of targets) {
        const key = `${target.meshName}:${target.name}`;
        if (batchKeys.has(key)) throw new Error(`Morph target appears more than once in batch: ${key}`);
        batchKeys.add(key);
        let stage = stages.get(target.meshName);
        if (!stage) {
          const mesh = root.getObjectByName(target.meshName);
          if (!mesh || !mesh.isMesh) throw new Error(`Mesh not found: ${target.meshName}`);
          stage = {
            mesh,
            sourceGeometry: mesh.geometry,
            geometry: mesh.geometry.clone(),
            dictionary: {
              ...mesh.morphTargetDictionary ?? mesh.geometry.morphTargetDictionary ?? {}
            },
            influences: [...mesh.morphTargetInfluences ?? []]
          };
          stages.set(target.meshName, stage);
        }
        result[key] = this.applyMorphTargetToStage(stage, target, options);
      }
    } catch (error) {
      for (const stage of stages.values()) stage.geometry.dispose();
      throw error;
    }
    const replaceGeometry = options.forceGeometryReplacement !== false;
    for (const stage of stages.values()) {
      const committedGeometry = replaceGeometry ? stage.geometry : stage.sourceGeometry;
      if (!replaceGeometry) {
        committedGeometry.morphAttributes = stage.geometry.morphAttributes;
        committedGeometry.morphTargetsRelative = stage.geometry.morphTargetsRelative;
        committedGeometry.boundingBox = stage.geometry.boundingBox;
        committedGeometry.boundingSphere = stage.geometry.boundingSphere;
      }
      committedGeometry.morphTargetDictionary = { ...stage.dictionary };
      stage.mesh.geometry = committedGeometry;
      stage.mesh.morphTargetDictionary = { ...stage.dictionary };
      stage.mesh.morphTargetInfluences = [...stage.influences];
    }
    if (replaceGeometry) {
      for (const stage of stages.values()) stage.sourceGeometry.dispose();
    }
    return result;
  }
  applyMorphTargetToStage(stage, target, options) {
    const geometry = stage.geometry;
    const dictionary = stage.dictionary;
    if (!target.name?.trim()) throw new Error(`Morph target name is required for mesh: ${target.meshName}`);
    const configuredIndex = dictionary[target.name];
    const existing = Number.isInteger(configuredIndex) && configuredIndex >= 0 ? configuredIndex : void 0;
    if (existing !== void 0 && !options.replace) throw new Error(`Morph target already exists: ${target.name}`);
    const usedIndices = Object.values(dictionary).map((value) => {
      if (!Number.isInteger(value) || value < 0) throw new Error(`Invalid morph target index on ${target.meshName}: ${value}`);
      return value;
    });
    const currentTargetCount = Math.max(
      0,
      ...Object.values(geometry.morphAttributes).map((attributes) => attributes?.length ?? 0),
      usedIndices.length > 0 ? Math.max(...usedIndices) + 1 : 0,
      stage.influences.length
    );
    const targetIsRelative = target.relative !== false;
    if (currentTargetCount > 0 && geometry.morphTargetsRelative !== targetIsRelative) {
      const existingMode = geometry.morphTargetsRelative ? "relative" : "absolute";
      const targetMode = targetIsRelative ? "relative" : "absolute";
      throw new Error(
        `Cannot add ${targetMode} morph target "${target.name}" to mesh "${target.meshName}" because existing morph targets are ${existingMode}.`
      );
    }
    const index = existing ?? currentTargetCount;
    const targetCount = Math.max(currentTargetCount, index + 1);
    if (currentTargetCount === 0) geometry.morphTargetsRelative = targetIsRelative;
    for (const semantic of MORPH_ATTRIBUTE_SEMANTICS) {
      const data = target[semantic];
      const existingAttributes = geometry.morphAttributes[semantic];
      if (!data && existingAttributes?.length === 0) {
        delete geometry.morphAttributes[semantic];
        continue;
      }
      if (!data && !existingAttributes) continue;
      const base = geometry.getAttribute(semantic);
      if (!base || data && data.length !== base.count * base.itemSize) {
        throw new Error(`Invalid ${semantic} morph data length`);
      }
      const attributes = [...existingAttributes ?? []];
      for (let targetIndex = 0; targetIndex < targetCount; targetIndex += 1) {
        if (targetIndex === index && data) {
          const attribute = new BufferAttribute(new Float32Array(Array.from(data)), base.itemSize);
          attribute.name = target.name;
          attributes[targetIndex] = attribute;
        } else if (!attributes[targetIndex] || targetIndex === index) {
          attributes[targetIndex] = createNeutralMorphAttribute(
            geometry,
            semantic,
            targetIndex === index ? target.name : `morph_${targetIndex}`
          );
        }
      }
      geometry.morphAttributes[semantic] = attributes;
    }
    dictionary[target.name] = index;
    geometry.morphTargetDictionary = { ...dictionary };
    while (stage.influences.length < targetCount) stage.influences.push(0);
    if (options.resetInfluence !== false) stage.influences[index] = 0;
    geometry.computeBoundingBox?.();
    geometry.computeBoundingSphere?.();
    return index;
  }
  applyMaterial(mesh, config) {
    if (typeof config.renderOrder === "number") mesh.renderOrder = config.renderOrder;
    for (const material of materials(mesh.material)) {
      if (typeof config.opacity === "number") material.opacity = config.opacity;
      if (typeof config.transparent === "boolean") material.transparent = config.transparent;
      else if (typeof config.opacity === "number" && config.opacity < 1) material.transparent = true;
      if (typeof config.depthWrite === "boolean") material.depthWrite = config.depthWrite;
      if (typeof config.depthTest === "boolean") material.depthTest = config.depthTest;
      if (config.blending) material.blending = THREE_BLENDING_MODES[config.blending];
      material.needsUpdate = true;
    }
  }
  visitMesh(root, name, visit) {
    root.traverse((object) => {
      if (object.isMesh && object.name === name) visit(object);
    });
  }
};
var collectMorphMeshes = (root) => {
  const meshes = [];
  root.traverse((object) => {
    if (object.isMesh && morphEntries(object).length > 0) meshes.push(object);
  });
  return meshes;
};

// assets/presets/cc4.json
var cc4_default = {
  hairColorPresets: {
    natural_black: {
      name: "Natural Black",
      baseColor: "#1a1a1a",
      emissive: "#000000",
      emissiveIntensity: 0
    },
    natural_brown: {
      name: "Natural Brown",
      baseColor: "#4a3728",
      emissive: "#000000",
      emissiveIntensity: 0
    },
    natural_blonde: {
      name: "Natural Blonde",
      baseColor: "#e6c78a",
      emissive: "#000000",
      emissiveIntensity: 0
    },
    natural_red: {
      name: "Natural Red",
      baseColor: "#8b3a3a",
      emissive: "#000000",
      emissiveIntensity: 0
    },
    natural_gray: {
      name: "Natural Gray",
      baseColor: "#9e9e9e",
      emissive: "#000000",
      emissiveIntensity: 0
    },
    natural_white: {
      name: "Natural White",
      baseColor: "#f5f5f5",
      emissive: "#000000",
      emissiveIntensity: 0
    },
    neon_blue: {
      name: "Neon Blue",
      baseColor: "#00ffff",
      emissive: "#0000ff",
      emissiveIntensity: 0.8
    },
    neon_pink: {
      name: "Neon Pink",
      baseColor: "#ff00ff",
      emissive: "#ff1493",
      emissiveIntensity: 0.8
    },
    neon_green: {
      name: "Neon Green",
      baseColor: "#00ff00",
      emissive: "#00ff00",
      emissiveIntensity: 0.8
    },
    electric_purple: {
      name: "Electric Purple",
      baseColor: "#9d00ff",
      emissive: "#9d00ff",
      emissiveIntensity: 0.6
    },
    fire_orange: {
      name: "Fire Orange",
      baseColor: "#ff6600",
      emissive: "#ff3300",
      emissiveIntensity: 0.7
    }
  }
};

// assets/templates/cc4-humanoid.json
var cc4_humanoid_default = {
  id: "cc4-humanoid",
  sourceCharacterId: "cc4",
  sourceAsset: "assets/presets/cc4.json",
  sourceSkinName: "Armature",
  bones: [
    {
      name: "CC_Base_BoneRoot",
      parent: null,
      translation: [
        0,
        0,
        0
      ]
    },
    {
      name: "CC_Base_Hip",
      parent: "CC_Base_BoneRoot",
      translation: [
        0,
        0,
        102.33650207519531
      ]
    },
    {
      name: "CC_Base_Pelvis",
      parent: "CC_Base_Hip",
      translation: [
        -3790411029074318e-30,
        30517578125e-15,
        -7.908884072094224e-7
      ]
    },
    {
      name: "CC_Base_L_Thigh",
      parent: "CC_Base_Pelvis",
      translation: [
        9.953155517578125,
        -1.789858102798462,
        -1.3750107288360596
      ]
    },
    {
      name: "CC_Base_L_Calf",
      parent: "CC_Base_L_Thigh",
      translation: [
        0.0010912826983258128,
        47.572593688964844,
        -25631440803408623e-20
      ]
    },
    {
      name: "CC_Base_L_Foot",
      parent: "CC_Base_L_Calf",
      translation: [
        0.012946736067533493,
        47.30466842651367,
        0.0028991601429879665
      ]
    },
    {
      name: "CC_Base_L_ToeBaseShareBone",
      parent: "CC_Base_L_Foot",
      translation: [
        -15205750241875648e-20,
        15.384612083435059,
        8890032768249512e-20
      ]
    },
    {
      name: "CC_Base_L_ToeBase",
      parent: "CC_Base_L_Foot",
      translation: [
        -15205750241875648e-20,
        15.384612083435059,
        8890032768249512e-20
      ]
    },
    {
      name: "CC_Base_L_PinkyToe1",
      parent: "CC_Base_L_ToeBase",
      translation: [
        -2.8338863849639893,
        0.00474335253238678,
        -0.449185848236084
      ]
    },
    {
      name: "CC_Base_L_RingToe1",
      parent: "CC_Base_L_ToeBase",
      translation: [
        -1.4594630002975464,
        1.165667176246643,
        -0.024081647396087646
      ]
    },
    {
      name: "CC_Base_L_MidToe1",
      parent: "CC_Base_L_ToeBase",
      translation: [
        -5848705768585205e-21,
        2.3142271041870117,
        5245208740234375e-20
      ]
    },
    {
      name: "CC_Base_L_IndexToe1",
      parent: "CC_Base_L_ToeBase",
      translation: [
        1.5948846340179443,
        2.64426851272583,
        0.3221862316131592
      ]
    },
    {
      name: "CC_Base_L_BigToe1",
      parent: "CC_Base_L_ToeBase",
      translation: [
        3.8480422496795654,
        2.5877017974853516,
        0.018612831830978394
      ]
    },
    {
      name: "CC_Base_L_CalfTwist01",
      parent: "CC_Base_L_Calf",
      translation: [
        -9258394129574299e-21,
        4678964614868164e-21,
        -3.073364496231079e-8
      ]
    },
    {
      name: "CC_Base_L_CalfTwist02",
      parent: "CC_Base_L_CalfTwist01",
      translation: [
        0.008389605209231377,
        23.652305603027344,
        0.0010145818814635277
      ]
    },
    {
      name: "CC_Base_L_KneeShareBone",
      parent: "CC_Base_L_Calf",
      translation: [
        -9258394129574299e-21,
        4678964614868164e-21,
        -3.073364496231079e-8
      ]
    },
    {
      name: "CC_Base_L_ThighTwist01",
      parent: "CC_Base_L_Thigh",
      translation: [
        -5.249967216514051e-8,
        -446811318397522e-19,
        7050111889839172e-22
      ]
    },
    {
      name: "CC_Base_L_ThighTwist02",
      parent: "CC_Base_L_ThighTwist01",
      translation: [
        5524034495465457e-19,
        23.786300659179688,
        3187847323715687e-20
      ]
    },
    {
      name: "CC_Base_R_Thigh",
      parent: "CC_Base_Pelvis",
      translation: [
        -9.953006744384766,
        -1.7889251708984375,
        -1.3763487339019775
      ]
    },
    {
      name: "CC_Base_R_Calf",
      parent: "CC_Base_R_Thigh",
      translation: [
        -0.001107644522562623,
        47.52029800415039,
        4845880903303623e-20
      ]
    },
    {
      name: "CC_Base_R_KneeShareBone",
      parent: "CC_Base_R_Calf",
      translation: [
        -7073394954204559e-21,
        -2518296241760254e-21,
        19818544387817383e-22
      ]
    },
    {
      name: "CC_Base_R_Foot",
      parent: "CC_Base_R_Calf",
      translation: [
        -0.011737369000911713,
        47.35129928588867,
        -0.0035943761467933655
      ]
    },
    {
      name: "CC_Base_R_ToeBase",
      parent: "CC_Base_R_Foot",
      translation: [
        23105042055249214e-20,
        15.38337230682373,
        45359134674072266e-20
      ]
    },
    {
      name: "CC_Base_R_BigToe1",
      parent: "CC_Base_R_ToeBase",
      translation: [
        -3.848090648651123,
        2.587796926498413,
        0.018401414155960083
      ]
    },
    {
      name: "CC_Base_R_PinkyToe1",
      parent: "CC_Base_R_ToeBase",
      translation: [
        2.8339407444000244,
        0.005379915237426758,
        -0.4495028853416443
      ]
    },
    {
      name: "CC_Base_R_RingToe1",
      parent: "CC_Base_R_ToeBase",
      translation: [
        1.4595259428024292,
        1.1659480333328247,
        -0.02425825595855713
      ]
    },
    {
      name: "CC_Base_R_IndexToe1",
      parent: "CC_Base_R_ToeBase",
      translation: [
        -1.59493887424469,
        2.64436674118042,
        0.32200416922569275
      ]
    },
    {
      name: "CC_Base_R_MidToe1",
      parent: "CC_Base_R_ToeBase",
      translation: [
        -912696123123169e-20,
        2.3142714500427246,
        1671910285949707e-20
      ]
    },
    {
      name: "CC_Base_R_ToeBaseShareBone",
      parent: "CC_Base_R_Foot",
      translation: [
        23105042055249214e-20,
        15.38337230682373,
        45359134674072266e-20
      ]
    },
    {
      name: "CC_Base_R_CalfTwist01",
      parent: "CC_Base_R_Calf",
      translation: [
        -7073394954204559e-21,
        -2518296241760254e-21,
        19818544387817383e-22
      ]
    },
    {
      name: "CC_Base_R_CalfTwist02",
      parent: "CC_Base_R_CalfTwist01",
      translation: [
        -0.005310218781232834,
        23.675636291503906,
        -0.0015991628170013428
      ]
    },
    {
      name: "CC_Base_R_ThighTwist01",
      parent: "CC_Base_R_Thigh",
      translation: [
        30152787076076493e-22,
        -12714415788650513e-21,
        -5.024485290050507e-7
      ]
    },
    {
      name: "CC_Base_R_ThighTwist02",
      parent: "CC_Base_R_ThighTwist01",
      translation: [
        -532150617800653e-18,
        23.760181427001953,
        -5566661711782217e-19
      ]
    },
    {
      name: "CC_Base_Waist",
      parent: "CC_Base_Hip",
      translation: [
        0,
        7.9917144775390625,
        1.035797119140625
      ]
    },
    {
      name: "CC_Base_Spine01",
      parent: "CC_Base_Waist",
      translation: [
        12880583372901905e-29,
        4.44435453414917,
        36954879760742188e-22
      ]
    },
    {
      name: "CC_Base_Spine02",
      parent: "CC_Base_Spine01",
      translation: [
        13552527156068805e-36,
        14.241397857666016,
        -852346420288086e-20
      ]
    },
    {
      name: "CC_Base_NeckTwist01",
      parent: "CC_Base_Spine02",
      translation: [
        -1075023646990303e-21,
        29.157955169677734,
        44345855712890625e-21
      ]
    },
    {
      name: "CC_Base_NeckTwist02",
      parent: "CC_Base_NeckTwist01",
      translation: [
        8672486728755757e-24,
        3.354764223098755,
        13446807861328125e-20
      ]
    },
    {
      name: "CC_Base_Head",
      parent: "CC_Base_NeckTwist02",
      translation: [
        41776246507652104e-20,
        3.995985746383667,
        -1358989356958773e-20
      ]
    },
    {
      name: "CC_Base_FacialBone",
      parent: "CC_Base_Head",
      translation: [
        5114753065527111e-26,
        15347271983046085e-21,
        -7390974587906385e-21
      ]
    },
    {
      name: "CC_Base_JawRoot",
      parent: "CC_Base_FacialBone",
      translation: [
        1.856170654296875,
        2.3725814819335938,
        -0.026499934494495392
      ]
    },
    {
      name: "CC_Base_Tongue01",
      parent: "CC_Base_JawRoot",
      translation: [
        3.4788222312927246,
        1.3013767004013062,
        0.001722173416055739
      ]
    },
    {
      name: "CC_Base_Tongue02",
      parent: "CC_Base_Tongue01",
      translation: [
        1.211624026298523,
        7291115616681054e-20,
        23348256945610046e-22
      ]
    },
    {
      name: "CC_Base_Tongue03",
      parent: "CC_Base_Tongue02",
      translation: [
        1.8075196743011475,
        4838673339691013e-19,
        1673889346420765e-20
      ]
    },
    {
      name: "CC_Base_Teeth02",
      parent: "CC_Base_JawRoot",
      translation: [
        3.509425640106201,
        1.6364113092422485,
        0.025405975058674812
      ]
    },
    {
      name: "CC_Base_R_Eye",
      parent: "CC_Base_FacialBone",
      translation: [
        7.916625499725342,
        8.004108428955078,
        -3.399050235748291
      ]
    },
    {
      name: "CC_Base_L_Eye",
      parent: "CC_Base_FacialBone",
      translation: [
        7.864105701446533,
        7.835659027099609,
        3.473083019256592
      ]
    },
    {
      name: "CC_Base_UpperJaw",
      parent: "CC_Base_FacialBone",
      translation: [
        3.261932373046875,
        6.942871570587158,
        -0.02468101494014263
      ]
    },
    {
      name: "CC_Base_Teeth01",
      parent: "CC_Base_UpperJaw",
      translation: [
        0.09780752658843994,
        0.021660717204213142,
        0.023386476561427116
      ]
    },
    {
      name: "CC_Base_L_Clavicle",
      parent: "CC_Base_Spine02",
      translation: [
        5.846743106842041,
        22.913326263427734,
        0.15851521492004395
      ]
    },
    {
      name: "CC_Base_L_Upperarm",
      parent: "CC_Base_L_Clavicle",
      translation: [
        6332993507385254e-20,
        13.675213813781738,
        40340423583984375e-20
      ]
    },
    {
      name: "CC_Base_L_Forearm",
      parent: "CC_Base_L_Upperarm",
      translation: [
        -0.0021000131964683533,
        29.648496627807617,
        5214959383010864e-19
      ]
    },
    {
      name: "CC_Base_L_ForearmTwist01",
      parent: "CC_Base_L_Forearm",
      translation: [
        -2450495958328247e-20,
        -63749030232429504e-22,
        5811452865600586e-21
      ]
    },
    {
      name: "CC_Base_L_ForearmTwist02",
      parent: "CC_Base_L_ForearmTwist01",
      translation: [
        -0.0017938688397407532,
        12.154339790344238,
        -0.0031246542930603027
      ]
    },
    {
      name: "CC_Base_L_ElbowShareBone",
      parent: "CC_Base_L_Forearm",
      translation: [
        -2450495958328247e-20,
        -63749030232429504e-22,
        5811452865600586e-21
      ]
    },
    {
      name: "CC_Base_L_Hand",
      parent: "CC_Base_L_Forearm",
      translation: [
        -0.0032659247517585754,
        24.308786392211914,
        -0.0040430426597595215
      ]
    },
    {
      name: "CC_Base_L_Pinky1",
      parent: "CC_Base_L_Hand",
      translation: [
        0.8387796878814697,
        9.643739700317383,
        -1.8876361846923828
      ]
    },
    {
      name: "CC_Base_L_Pinky2",
      parent: "CC_Base_L_Pinky1",
      translation: [
        396043062210083e-18,
        3.0504348278045654,
        -1811981201171875e-19
      ]
    },
    {
      name: "CC_Base_L_Pinky3",
      parent: "CC_Base_L_Pinky2",
      translation: [
        38370490074157715e-21,
        1.9355652332305908,
        -3510713577270508e-20
      ]
    },
    {
      name: "CC_Base_L_Ring1",
      parent: "CC_Base_L_Hand",
      translation: [
        0.0010117590427398682,
        9.706981658935547,
        0.0030269622802734375
      ]
    },
    {
      name: "CC_Base_L_Ring2",
      parent: "CC_Base_L_Ring1",
      translation: [
        -1965165138244629e-19,
        4.398406982421875,
        -5393028259277344e-19
      ]
    },
    {
      name: "CC_Base_L_Ring3",
      parent: "CC_Base_L_Ring2",
      translation: [
        -8174926042556763e-19,
        3.074361801147461,
        6477683782577515e-19
      ]
    },
    {
      name: "CC_Base_L_Mid1",
      parent: "CC_Base_L_Hand",
      translation: [
        -0.6153436303138733,
        9.996679306030273,
        1.9597835540771484
      ]
    },
    {
      name: "CC_Base_L_Mid2",
      parent: "CC_Base_L_Mid1",
      translation: [
        -2244412899017334e-19,
        4.767321586608887,
        -41157007217407227e-21
      ]
    },
    {
      name: "CC_Base_L_Mid3",
      parent: "CC_Base_L_Mid2",
      translation: [
        -0.0010398924350738525,
        3.306338310241699,
        -8061528205871582e-19
      ]
    },
    {
      name: "CC_Base_L_Index1",
      parent: "CC_Base_L_Hand",
      translation: [
        -0.4277152717113495,
        9.799840927124023,
        4.421895980834961
      ]
    },
    {
      name: "CC_Base_L_Index2",
      parent: "CC_Base_L_Index1",
      translation: [
        -0.001440480351448059,
        4.649103164672852,
        0.001256398856639862
      ]
    },
    {
      name: "CC_Base_L_Index3",
      parent: "CC_Base_L_Index2",
      translation: [
        -5395412445068359e-19,
        2.933397054672241,
        52034854888916016e-21
      ]
    },
    {
      name: "CC_Base_L_Thumb1",
      parent: "CC_Base_L_Hand",
      translation: [
        0.4729442000389099,
        1.4073847532272339,
        2.9682064056396484
      ]
    },
    {
      name: "CC_Base_L_Thumb2",
      parent: "CC_Base_L_Thumb1",
      translation: [
        -3701448440551758e-20,
        7.252772331237793,
        -34561753273010254e-20
      ]
    },
    {
      name: "CC_Base_L_Thumb3",
      parent: "CC_Base_L_Thumb2",
      translation: [
        -9371936321258545e-19,
        3.2246363162994385,
        -3355741500854492e-19
      ]
    },
    {
      name: "CC_Base_L_UpperarmTwist01",
      parent: "CC_Base_L_Upperarm",
      translation: [
        -24765729904174805e-21,
        -8791685104370117e-21,
        -4850327968597412e-21
      ]
    },
    {
      name: "CC_Base_L_UpperarmTwist02",
      parent: "CC_Base_L_UpperarmTwist01",
      translation: [
        -5109608173370361e-20,
        14.824237823486328,
        -4093348979949951e-20
      ]
    },
    {
      name: "CC_Base_L_RibsTwist",
      parent: "CC_Base_Spine02",
      translation: [
        12.37477970123291,
        4.240516662597656,
        11.340028762817383
      ]
    },
    {
      name: "CC_Base_L_Breast",
      parent: "CC_Base_L_RibsTwist",
      translation: [
        15254845493473113e-21,
        1.999998688697815,
        8869566954672337e-20
      ]
    },
    {
      name: "CC_Base_R_RibsTwist",
      parent: "CC_Base_Spine02",
      translation: [
        -12.366527557373047,
        4.255687236785889,
        11.342021942138672
      ]
    },
    {
      name: "CC_Base_R_Breast",
      parent: "CC_Base_R_RibsTwist",
      translation: [
        -14992387150414288e-21,
        1.9999765157699585,
        698570511303842e-19
      ]
    },
    {
      name: "CC_Base_R_Clavicle",
      parent: "CC_Base_Spine02",
      translation: [
        -5.847836017608643,
        22.913354873657227,
        0.158738374710083
      ]
    },
    {
      name: "CC_Base_R_Upperarm",
      parent: "CC_Base_R_Clavicle",
      translation: [
        -38962066173553467e-20,
        13.675079345703125,
        13494491577148438e-20
      ]
    },
    {
      name: "CC_Base_R_Forearm",
      parent: "CC_Base_R_Upperarm",
      translation: [
        0.0014372840523719788,
        29.647546768188477,
        -34911930561065674e-20
      ]
    },
    {
      name: "CC_Base_R_ElbowShareBone",
      parent: "CC_Base_R_Forearm",
      translation: [
        4427880048751831e-20,
        -5062669515609741e-21,
        19073486328125e-19
      ]
    },
    {
      name: "CC_Base_R_ForearmTwist01",
      parent: "CC_Base_R_Forearm",
      translation: [
        4427880048751831e-20,
        -5062669515609741e-21,
        19073486328125e-19
      ]
    },
    {
      name: "CC_Base_R_ForearmTwist02",
      parent: "CC_Base_R_ForearmTwist01",
      translation: [
        0.0017296746373176575,
        12.154948234558105,
        -0.0021570324897766113
      ]
    },
    {
      name: "CC_Base_R_Hand",
      parent: "CC_Base_R_Forearm",
      translation: [
        0.0013648197054862976,
        24.31002426147461,
        -3132820129394531e-19
      ]
    },
    {
      name: "CC_Base_R_Ring1",
      parent: "CC_Base_R_Hand",
      translation: [
        73462724685668945e-22,
        9.707071304321289,
        -7748603820800781e-19
      ]
    },
    {
      name: "CC_Base_R_Ring2",
      parent: "CC_Base_R_Ring1",
      translation: [
        15947222709655762e-20,
        4.398307800292969,
        -6395876407623291e-19
      ]
    },
    {
      name: "CC_Base_R_Ring3",
      parent: "CC_Base_R_Ring2",
      translation: [
        -0.0010596513748168945,
        3.074486494064331,
        -25691837072372437e-20
      ]
    },
    {
      name: "CC_Base_R_Mid1",
      parent: "CC_Base_R_Hand",
      translation: [
        0.6159845590591431,
        9.997448921203613,
        1.9559621810913086
      ]
    },
    {
      name: "CC_Base_R_Mid2",
      parent: "CC_Base_R_Mid1",
      translation: [
        445440411567688e-18,
        4.767148494720459,
        -16441941261291504e-20
      ]
    },
    {
      name: "CC_Base_R_Mid3",
      parent: "CC_Base_R_Mid2",
      translation: [
        12923777103424072e-20,
        3.306414842605591,
        5930662155151367e-20
      ]
    },
    {
      name: "CC_Base_R_Thumb1",
      parent: "CC_Base_R_Hand",
      translation: [
        -0.4736732244491577,
        1.408708095550537,
        2.9675445556640625
      ]
    },
    {
      name: "CC_Base_R_Thumb2",
      parent: "CC_Base_R_Thumb1",
      translation: [
        3608446568250656e-19,
        7.252943515777588,
        -981692224740982e-18
      ]
    },
    {
      name: "CC_Base_R_Thumb3",
      parent: "CC_Base_R_Thumb2",
      translation: [
        -9268522262573242e-21,
        3.2248055934906006,
        4887580871582031e-20
      ]
    },
    {
      name: "CC_Base_R_Index1",
      parent: "CC_Base_R_Hand",
      translation: [
        0.4276627004146576,
        9.801568984985352,
        4.418048858642578
      ]
    },
    {
      name: "CC_Base_R_Index2",
      parent: "CC_Base_R_Index1",
      translation: [
        0.001061864197254181,
        4.648791790008545,
        6793588399887085e-19
      ]
    },
    {
      name: "CC_Base_R_Index3",
      parent: "CC_Base_R_Index2",
      translation: [
        -6211921572685242e-19,
        2.9368622303009033,
        -16835331916809082e-20
      ]
    },
    {
      name: "CC_Base_R_Pinky1",
      parent: "CC_Base_R_Hand",
      translation: [
        -0.837287962436676,
        9.643238067626953,
        -1.891557216644287
      ]
    },
    {
      name: "CC_Base_R_Pinky2",
      parent: "CC_Base_R_Pinky1",
      translation: [
        -3053247928619385e-19,
        3.050346851348877,
        -22897124290466309e-20
      ]
    },
    {
      name: "CC_Base_R_Pinky3",
      parent: "CC_Base_R_Pinky2",
      translation: [
        -6973743438720703e-21,
        1.9355270862579346,
        15944242477416992e-22
      ]
    },
    {
      name: "CC_Base_R_UpperarmTwist01",
      parent: "CC_Base_R_Upperarm",
      translation: [
        4403293132781982e-21,
        33676624298095703e-22,
        -2473592758178711e-21
      ]
    },
    {
      name: "CC_Base_R_UpperarmTwist02",
      parent: "CC_Base_R_UpperarmTwist01",
      translation: [
        -0.0015784502029418945,
        14.823780059814453,
        -3107339143753052e-19
      ]
    }
  ]
};

// wasm/index.ts
var EMBODY_CORE_ABI_VERSION = 1;
var PACKED_MORPH_FRAME_DELTA_STRIDE = 4;
var PACKED_BONE_FRAME_DELTA_STRIDE = 9;
var HAIR_CONFIG_STRIDE = 11;
var HAIR_STATE_STRIDE = 4;
var HAIR_HEAD_STATE_STRIDE = 5;
var HAIR_MORPH_OUTPUT_STRIDE = 6;
var MESH_PROPORTIONS_STRIDE = 16;
var TEMPLATE_SKELETON_FIT_SOLUTION_STRIDE = 10;
var TEMPLATE_SKELETON_FIT_TRANSFORM_STRIDE = 4;
var ANNOTATION_CAMERA_FRAMING_STRIDE = 7;
var CAMERA_FLIGHT_SAMPLE_STRIDE = 7;
var MARKER_VISIBILITY_FACTORS_STRIDE = 3;
var MARKER_ENDPOINT_STRIDE = 3;
var HAIR_COLOR_PRESETS = cc4_default.hairColorPresets;
var DEFAULT_HAIR_COLOR_APPEARANCE = HAIR_COLOR_PRESETS.natural_brown;
var CC4_HUMANOID_SKELETON_TEMPLATE = cc4_humanoid_default;
var HUMANOID_SKELETON_TEMPLATES = [CC4_HUMANOID_SKELETON_TEMPLATE];
var pending = null;
var loaded = null;
async function initEmbodyCore() {
  if (!pending) {
    pending = load().catch((error) => {
      pending = null;
      loaded = null;
      throw error;
    });
  }
  return pending;
}
var getEmbodyCore = initEmbodyCore;
function requireInitializedEmbodyCore() {
  if (!loaded) throw new Error("Embody Wasm core is not initialized. Await initEmbodyCore() first.");
  return loaded;
}
function resetEmbodyCoreForTests() {
  pending = null;
  loaded = null;
}
async function load() {
  const resolveAsset = (path) => new URL(path, import.meta.url);
  const moduleUrl = resolveAsset("./wasm/embody_wasm.js").href;
  const binaryUrl = resolveAsset("./wasm/embody_wasm_bg.wasm");
  const core = await import(
    /* @vite-ignore */
    moduleUrl
  );
  if (typeof core.default === "function") {
    let input = binaryUrl;
    if (globalThis.process?.versions?.node && binaryUrl.protocol === "file:") {
      const fsSpecifier = "node:fs/promises";
      const urlSpecifier = "node:url";
      const [{ readFile }, { fileURLToPath }] = await Promise.all([
        import(
          /* @vite-ignore */
          fsSpecifier
        ),
        import(
          /* @vite-ignore */
          urlSpecifier
        )
      ]);
      input = await readFile(fileURLToPath(binaryUrl));
    }
    await core.default({ module_or_path: input });
  }
  if (core.core_abi_version() !== EMBODY_CORE_ABI_VERSION) {
    throw new Error(`Unsupported Embody Wasm ABI version ${core.core_abi_version()}.`);
  }
  loaded = core;
  return core;
}

export { ANNOTATION_CAMERA_FRAMING_STRIDE, CAMERA_FLIGHT_SAMPLE_STRIDE, CC4_HUMANOID_SKELETON_TEMPLATE, CHARACTER_SCENE_TYPES, CHARACTER_SCENE_TYPE_IDS, DEFAULT_CHARACTER_LIGHTING_PRESETS, DEFAULT_CHARACTER_LIGHTING_PRESET_ID, DEFAULT_CHARACTER_LIGHTING_PRESET_IDS, DEFAULT_CHARACTER_LIGHTING_SETTINGS, DEFAULT_CHARACTER_SCENE_TYPE_ID, DEFAULT_HAIR_COLOR_APPEARANCE, EMBODY_CORE_ABI_VERSION, HAIR_COLOR_PRESETS, HAIR_CONFIG_STRIDE, HAIR_HEAD_STATE_STRIDE, HAIR_MORPH_OUTPUT_STRIDE, HAIR_STATE_STRIDE, HUMANOID_SKELETON_TEMPLATES, MARKER_ENDPOINT_STRIDE, MARKER_VISIBILITY_FACTORS_STRIDE, MESH_PROPORTIONS_STRIDE, PACKED_BONE_FRAME_DELTA_STRIDE, PACKED_MORPH_FRAME_DELTA_STRIDE, TEMPLATE_SKELETON_FIT_SOLUTION_STRIDE, TEMPLATE_SKELETON_FIT_TRANSFORM_STRIDE, THREE_BLENDING_MODES, ThreeFrameApplier, ThreeModelInspector, applyCharacterModelTransform, collectMorphMeshes, createAnimationClipFromClipIR, createDefaultCharacterLighting, createDefaultCharacterScene, createShadowPlane, disposeCharacterModel, getEmbodyCore, initEmbodyCore, loadCharacterModel, normalizeDefaultCharacterLightingSettings, parseCharacterModel, requireInitializedEmbodyCore, resetEmbodyCoreForTests, serializeAnimationClips };
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map