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
    const mesh = root.getObjectByName(target.meshName);
    if (!mesh || !mesh.isMesh) throw new Error(`Mesh not found: ${target.meshName}`);
    if (options.forceGeometryReplacement !== false) mesh.geometry = mesh.geometry.clone();
    const geometry = mesh.geometry;
    const dictionary = { ...mesh.morphTargetDictionary ?? {} };
    const configuredIndex = dictionary[target.name];
    const existing = Number.isInteger(configuredIndex) && configuredIndex >= 0 ? configuredIndex : void 0;
    if (existing !== void 0 && !options.replace) throw new Error(`Morph target already exists: ${target.name}`);
    const usedIndices = Object.values(dictionary).filter((value) => Number.isInteger(value) && value >= 0);
    const currentTargetCount = Math.max(
      0,
      ...Object.values(geometry.morphAttributes).map((attributes) => attributes?.length ?? 0),
      usedIndices.length > 0 ? Math.max(...usedIndices) + 1 : 0,
      mesh.morphTargetInfluences?.length ?? 0
    );
    const index = existing ?? currentTargetCount;
    const targetCount = Math.max(currentTargetCount, index + 1);
    geometry.morphTargetsRelative = target.relative !== false;
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
    mesh.morphTargetDictionary = dictionary;
    geometry.morphTargetDictionary = { ...dictionary };
    const influences = [...mesh.morphTargetInfluences ?? []];
    while (influences.length <= index) influences.push(0);
    if (options.resetInfluence !== false) influences[index] = 0;
    mesh.morphTargetInfluences = influences;
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

export { CHARACTER_SCENE_TYPES, CHARACTER_SCENE_TYPE_IDS, DEFAULT_CHARACTER_LIGHTING_PRESETS, DEFAULT_CHARACTER_LIGHTING_PRESET_ID, DEFAULT_CHARACTER_LIGHTING_PRESET_IDS, DEFAULT_CHARACTER_LIGHTING_SETTINGS, DEFAULT_CHARACTER_SCENE_TYPE_ID, THREE_BLENDING_MODES, ThreeFrameApplier, ThreeModelInspector, applyCharacterModelTransform, collectMorphMeshes, createAnimationClipFromClipIR, createDefaultCharacterLighting, createDefaultCharacterScene, createShadowPlane, disposeCharacterModel, loadCharacterModel, normalizeDefaultCharacterLightingSettings, parseCharacterModel, serializeAnimationClips };
//# sourceMappingURL=three.js.map
//# sourceMappingURL=three.js.map