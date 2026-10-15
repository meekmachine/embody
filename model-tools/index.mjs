import { WebIO } from '@gltf-transform/core';
import { MeshoptSimplifier } from 'meshoptimizer/simplifier';

const KINDS = new Set(['original', 'optimized', 'low-resolution', 'miniature', 'bust', 'outfit']);

function abortIfNeeded(signal) {
  if (signal?.aborted) {
    const error = new Error('Actor Model preparation cancelled.');
    error.name = 'AbortError';
    throw error;
  }
}

async function yieldToCaller(signal) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  abortIfNeeded(signal);
}

function readSource(source) {
  if (!(source instanceof Uint8Array)) throw new TypeError('Actor Model source must be a Uint8Array.');
  // Own both JSON and binary data before any asynchronous work can observe caller mutations.
  const bytes = new Uint8Array(source);
  if (bytes.byteLength < 20) throw new Error('Actor Model must be a glTF 2.0 binary (.glb).');
  const view = new DataView(bytes.buffer);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2
    || view.getUint32(8, true) !== bytes.byteLength) {
    throw new Error('Actor Model has an invalid GLB header or length.');
  }
  let json;
  let chunkCount = 0;
  for (let offset = 12; offset < bytes.byteLength;) {
    if (offset + 8 > bytes.byteLength) throw new Error('Actor Model has an incomplete GLB chunk.');
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    if (length % 4 || offset + 8 + length > bytes.byteLength) throw new Error('Actor Model has an invalid GLB chunk length.');
    if (chunkCount === 0 && type === 0x4e4f534a) {
      json = JSON.parse(new TextDecoder().decode(bytes.subarray(offset + 8, offset + 8 + length)));
    } else if (chunkCount !== 1 || type !== 0x004e4942) {
      throw new Error('Actor Model must contain only the GLB JSON and optional binary chunks.');
    }
    offset += 8 + length;
    chunkCount++;
  }
  if (!json || json.asset?.version !== '2.0') throw new Error('Actor Model must declare glTF version 2.0.');
  return { bytes, json };
}

function inspectionOf(json, byteLength) {
  const warnings = [];
  const extensionNames = new Set([...(json.extensionsUsed ?? []), ...(json.extensionsRequired ?? [])]);
  // Also reject undeclared extension payloads; a rewrite must not silently discard them.
  function findExtensions(value) {
    if (!value || typeof value !== 'object') return;
    if (!Array.isArray(value) && value.extensions) {
      Object.keys(value.extensions).forEach((name) => extensionNames.add(name));
    }
    for (const [key, child] of Object.entries(value)) {
      if (key !== 'extras' && key !== 'extensions') findExtensions(child);
    }
  }
  findExtensions(json);
  const unsupportedExtensions = [...extensionNames].sort();
  if (unsupportedExtensions.length) warnings.push(`Processing requires extension-free GLB: ${unsupportedExtensions.join(', ')}.`);
  const hasURIs = [...(json.buffers ?? []), ...(json.images ?? [])].some((resource) => resource.uri !== undefined);
  if (hasURIs) warnings.push('Processing requires embedded binary resources; external and data URIs are not supported.');
  const meshes = (json.meshes ?? []).map((mesh, index) => {
    const nodes = (json.nodes ?? []).filter((node) => node.mesh === index);
    let vertexCount = 0;
    let triangleCount = 0;
    let morphTargetCount = 0;
    const materials = new Set();
    for (const primitive of mesh.primitives ?? []) {
      const position = json.accessors?.[primitive.attributes?.POSITION];
      if (!Number.isInteger(position?.count) || position.count < 0) throw new Error(`Mesh ${index} has no valid POSITION accessor.`);
      vertexCount += position.count;
      const count = primitive.indices === undefined ? position.count : json.accessors?.[primitive.indices]?.count;
      if (!Number.isInteger(count) || count < 0) throw new Error(`Mesh ${index} has invalid indices.`);
      const mode = primitive.mode ?? 4;
      triangleCount += mode === 4 ? Math.floor(count / 3) : (mode === 5 || mode === 6) ? Math.max(0, count - 2) : 0;
      morphTargetCount = Math.max(morphTargetCount, primitive.targets?.length ?? 0);
      if (primitive.material !== undefined) materials.add(json.materials?.[primitive.material]?.name || `Material ${primitive.material + 1}`);
    }
    return {
      id: `mesh:${index}`, name: mesh.name || nodes.find((node) => node.name)?.name || `Mesh ${index + 1}`,
      nodeNames: nodes.map((node) => node.name || ''), materials: [...materials],
      primitiveCount: mesh.primitives?.length ?? 0, vertexCount, triangleCount,
      skinned: nodes.some((node) => node.skin !== undefined), morphTargetCount,
    };
  });
  for (const resources of [json.meshes ?? [], json.nodes ?? []]) {
    const names = resources.map((resource) => resource.name);
    if (names.some((name) => !name) || new Set(names).size !== names.length) {
      warnings.push('Some mesh or node names are missing or duplicated. Verify Mapping targets against the prepared Model.');
      break;
    }
  }
  return {
    byteLength, meshes,
    vertexCount: meshes.reduce((sum, mesh) => sum + mesh.vertexCount, 0),
    triangleCount: meshes.reduce((sum, mesh) => sum + mesh.triangleCount, 0),
    animationCount: json.animations?.length ?? 0, skinCount: json.skins?.length ?? 0,
    canTransform: !unsupportedExtensions.length && !hasURIs,
    unsupportedExtensions, warnings,
  };
}

export async function inspectActorModel(source, { signal } = {}) {
  abortIfNeeded(signal);
  const { bytes, json } = readSource(source);
  return inspectionOf(json, bytes.byteLength);
}

function finiteRange(name, value, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}.`);
  }
  return value;
}

function validateOptions(options, before) {
  if (!options || !KINDS.has(options.kind)) throw new Error('Choose an Actor Model kind.');
  const knownIds = new Set(before.meshes.map((mesh) => mesh.id));
  function selectors(name) {
    const ids = options[name] ?? [];
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !knownIds.has(id))) {
      throw new Error(`${name} must contain mesh IDs from this source Model inspection.`);
    }
    if (new Set(ids).size !== ids.length) throw new Error(`${name} contains duplicate mesh IDs.`);
    return new Set(ids);
  }
  const remove = selectors('removeMeshIds');
  const keep = selectors('keepMeshIds');
  if (keep.size && remove.size) throw new Error('Choose meshes to keep or remove, not both.');
  if (options.kind === 'bust' && !keep.size) throw new Error('A bust requires explicit meshes to keep; a combined body mesh must be split in a modeling tool first.');
  if (options.kind === 'outfit' && !keep.size && !remove.size) throw new Error('Choose the garment meshes for this outfit.');
  if (options.kind === 'original' && (remove.size || keep.size || options.targetRatio !== undefined || options.scale !== undefined || options.maxError !== undefined)) {
    throw new Error('Original copies the source Model without processing options.');
  }
  if (options.scale !== undefined && options.kind !== 'miniature') throw new Error('Only miniature Models accept a scale.');
  const scale = options.kind === 'miniature' ? finiteRange('Miniature scale', options.scale, 0.01, 0.99) : 1;
  const ratio = finiteRange('Target triangle ratio', options.targetRatio ?? (options.kind === 'low-resolution' ? 0.5 : 1), 0.05, 1);
  const error = finiteRange('Maximum geometric error', options.maxError ?? 0.001, 0, 0.05);
  const removedMeshIds = before.meshes.filter((mesh) => remove.has(mesh.id) || (keep.size && !keep.has(mesh.id))).map((mesh) => mesh.id);
  if (before.meshes.length && removedMeshIds.length === before.meshes.length) throw new Error('An Actor Model must retain at least one mesh.');
  return { ratio, error, scale, removedMeshIds };
}

function removeMeshes(document, removedMeshIds, warnings) {
  const root = document.getRoot();
  const meshes = root.listMeshes();
  for (const id of removedMeshIds) {
    const mesh = meshes[Number(id.slice(5))];
    const nodes = root.listNodes().filter((node) => node.getMesh() === mesh);
    for (const animation of root.listAnimations()) {
      for (const channel of animation.listChannels()) {
        if (channel.getTargetPath() === 'weights' && nodes.includes(channel.getTargetNode())) {
          const sampler = channel.getSampler();
          channel.dispose();
          if (sampler && sampler.listParents().every((parent) => parent === animation)) sampler.dispose();
          warnings.push(`Removed a morph animation channel for removed mesh ${id}.`);
        }
      }
      if (!animation.listChannels().length) animation.dispose();
    }
    for (const node of nodes) node.setMesh(null).setSkin(null).setWeights([]);
    for (const primitive of mesh.listPrimitives()) {
      mesh.removePrimitive(primitive);
      if (primitive.listParents().length) continue;
      for (const target of primitive.listTargets()) {
        primitive.removeTarget(target);
        if (!target.listParents().length) target.dispose();
      }
      primitive.dispose();
    }
    mesh.dispose();
  }
}

function attributeValues(accessor) {
  const values = new Float32Array(accessor.getCount() * accessor.getElementSize());
  const element = [];
  for (let index = 0; index < accessor.getCount(); index++) {
    accessor.getElement(index, element);
    values.set(element, index * accessor.getElementSize());
  }
  return values;
}

function protectedVertices(primitive, indices, count) {
  const locks = new Uint8Array(count);
  // Preserve every vertex participating in an authored morph, including normals/tangents.
  for (const target of primitive.listTargets()) {
    for (const attribute of target.listAttributes()) {
      const values = attribute.getArray();
      const size = attribute.getElementSize();
      for (let vertex = 0; vertex < count; vertex++) {
        for (let component = 0; component < size; component++) {
          if (values[vertex * size + component] !== 0) locks[vertex] = 1;
        }
      }
    }
  }
  // Joint IDs are categorical. Lock transitions instead of treating IDs as continuous attributes.
  const skinAttributes = primitive.listSemantics().filter((semantic) => /^(JOINTS|WEIGHTS)_\d+$/.test(semantic))
    .map((semantic) => primitive.getAttribute(semantic));
  for (let index = 0; index < indices.length; index += 3) {
    const triangle = [indices[index], indices[index + 1], indices[index + 2]];
    const mixed = skinAttributes.some((attribute) => {
      const values = attribute.getArray();
      const size = attribute.getElementSize();
      return triangle.slice(1).some((vertex) => {
        for (let component = 0; component < size; component++) {
          if (values[vertex * size + component] !== values[triangle[0] * size + component]) return true;
        }
        return false;
      });
    });
    if (mixed) triangle.forEach((vertex) => { locks[vertex] = 1; });
  }
  return locks;
}

function compactPrimitive(document, primitive, indices) {
  const [remap, count] = MeshoptSimplifier.compactMesh(indices);
  const root = document.getRoot();
  const buffer = root.listBuffers()[0] ?? document.createBuffer();
  // compactMesh remaps the indices in place. Apply that one map to every stream, including targets.
  const cloneAttribute = (source) => {
    const sourceValues = source.getArray();
    const size = source.getElementSize();
    const values = new sourceValues.constructor(count * size);
    for (let vertex = 0; vertex < remap.length; vertex++) {
      if (remap[vertex] === 0xffffffff) continue;
      values.set(sourceValues.subarray(vertex * size, (vertex + 1) * size), remap[vertex] * size);
    }
    return document.createAccessor(source.getName()).setType(source.getType()).setNormalized(source.getNormalized())
      .setExtras(structuredClone(source.getExtras())).setBuffer(buffer).setArray(values);
  };
  for (const semantic of primitive.listSemantics()) primitive.setAttribute(semantic, cloneAttribute(primitive.getAttribute(semantic)));
  for (const target of primitive.listTargets()) {
    for (const semantic of target.listSemantics()) target.setAttribute(semantic, cloneAttribute(target.getAttribute(semantic)));
  }
  const compactedIndices = count <= 65534 ? new Uint16Array(indices) : indices;
  primitive.setIndices(document.createAccessor().setType('SCALAR').setBuffer(buffer).setArray(compactedIndices));
}

async function processPrimitives(document, ratio, error, warnings, signal) {
  if (!MeshoptSimplifier.supported) throw new Error('Actor Model preparation requires WebAssembly support.');
  await MeshoptSimplifier.ready;
  abortIfNeeded(signal);
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      await yieldToCaller(signal);
      const position = primitive.getAttribute('POSITION');
      if (primitive.getMode() !== 4) {
        warnings.push(`Kept non-triangle primitive in ${mesh.getName() || 'unnamed mesh'} unchanged.`);
        continue;
      }
      const count = position.getCount();
      if (position.getElementSize() !== 3 || count < 3) throw new Error(`Mesh ${mesh.getName()} has invalid triangle positions.`);
      const positions = attributeValues(position);
      if (positions.some((value) => !Number.isFinite(value))) throw new Error(`Mesh ${mesh.getName()} has invalid positions.`);
      for (const owner of [primitive, ...primitive.listTargets()]) {
        if (owner.listAttributes().some((attribute) => attribute.getCount() !== count)) {
          throw new Error(`Mesh ${mesh.getName()} has vertex streams with different lengths.`);
        }
      }
      const indexAccessor = primitive.getIndices();
      if (indexAccessor && (indexAccessor.getType() !== 'SCALAR' || indexAccessor.getNormalized()
        || ![5121, 5123, 5125].includes(indexAccessor.getComponentType()))) {
        throw new Error(`Mesh ${mesh.getName()} requires unsigned integer triangle indices.`);
      }
      const indices = indexAccessor ? new Uint32Array(indexAccessor.getArray())
        : Uint32Array.from({ length: count }, (_, index) => index);
      if (indices.length < 3 || indices.length % 3 || indices.some((index) => index >= count)) throw new Error(`Mesh ${mesh.getName()} has invalid triangle indices.`);
      let result = indices;
      if (ratio < 1 && indices.length > 3) {
        const locks = protectedVertices(primitive, indices, count);
        const attributes = ['NORMAL', 'TEXCOORD_0', 'TEXCOORD_1', 'COLOR_0']
          .map((semantic) => primitive.getAttribute(semantic)).filter(Boolean);
        const stride = attributes.reduce((sum, attribute) => sum + attribute.getElementSize(), 0);
        const packed = new Float32Array(count * stride);
        let offset = 0;
        for (const attribute of attributes) {
          const values = attributeValues(attribute);
          const size = attribute.getElementSize();
          for (let vertex = 0; vertex < count; vertex++) packed.set(values.subarray(vertex * size, (vertex + 1) * size), vertex * stride + offset);
          offset += size;
        }
        const target = Math.max(3, Math.floor(indices.length * ratio / 3) * 3);
        [result] = MeshoptSimplifier.simplifyWithAttributes(indices, positions, 3, packed, stride,
          new Array(stride).fill(1), locks, target, error, ['LockBorder', 'Regularize']);
        if (result.length > target) warnings.push(`${mesh.getName() || 'Unnamed mesh'} retained more triangles to preserve morphs, skinning, seams, and the error limit.`);
      }
      compactPrimitive(document, primitive, result);
    }
  }
}

function removeUnusedResources(document) {
  const root = document.getRoot();
  // Never prune scene nodes, joints, skins, animations, or their names. Only orphaned file resources.
  for (const resources of [root.listMaterials(), root.listTextures(), root.listAccessors()]) {
    for (const resource of resources) {
      if (resource.listParents().every((parent) => parent === root)) resource.dispose();
    }
  }
}

function scaleScenes(document, scale) {
  const wrappers = new Map();
  // addChild detaches a root from every scene, so capture all memberships before modifying any.
  const memberships = document.getRoot().listScenes().map((scene) => [scene, scene.listChildren()]);
  for (const [scene, children] of memberships) {
    // Parent the geometry and skeleton together; never bake scale into bind matrices or clips.
    // A root may be shared by scenes. Scaling those separately would detach it from the first one.
    for (const child of children) {
      scene.removeChild(child);
      if (!wrappers.has(child)) {
        const wrapper = document.createNode().setScale([scale, scale, scale]).addChild(child);
        wrappers.set(child, wrapper);
      }
      scene.addChild(wrappers.get(child));
    }
  }
}

export async function prepareActorModel(source, options) {
  abortIfNeeded(options?.signal);
  const { bytes, json } = readSource(source);
  const before = inspectionOf(json, bytes.byteLength);
  const { ratio, error, scale, removedMeshIds } = validateOptions(options, before);
  if (options.kind === 'original') return { bytes, before, after: before, removedMeshIds: [], warnings: [...before.warnings] };
  if (!before.canTransform) throw new Error(before.warnings.join(' '));
  if (!before.meshes.length) throw new Error('Actor Model contains no meshes.');
  const io = new WebIO();
  const document = await io.readBinary(bytes);
  abortIfNeeded(options.signal);
  const warnings = [...before.warnings];
  removeMeshes(document, removedMeshIds, warnings);
  await processPrimitives(document, ratio, error, warnings, options.signal);
  if (scale !== 1) scaleScenes(document, scale);
  removeUnusedResources(document);
  abortIfNeeded(options.signal);
  const output = await io.writeBinary(document);
  abortIfNeeded(options.signal);
  const after = await inspectActorModel(output, { signal: options.signal });
  if (ratio < 1 && after.triangleCount >= before.triangleCount) warnings.push('This Model could not be reduced within the requested limits.');
  if (output.byteLength >= bytes.byteLength) warnings.push('The prepared GLB is not smaller in bytes; textures are retained at their original resolution.');
  return { bytes: output, before, after, removedMeshIds, warnings: [...new Set(warnings)] };
}
