import { readGlbSource } from './glb-source.mjs';

// These extensions have only the inline factors/texture references remapped below.
// Compression, scene extensions, and unknown payloads must never be silently lost.
const MATERIAL_EXTENSIONS = new Set([
  'KHR_materials_unlit', 'KHR_materials_clearcoat', 'KHR_materials_emissive_strength',
  'KHR_materials_ior', 'KHR_materials_iridescence', 'KHR_materials_sheen',
  'KHR_materials_specular', 'KHR_materials_transmission', 'KHR_materials_volume',
  'KHR_materials_anisotropy', 'KHR_materials_dispersion', 'EXT_materials_bump',
]);
const EXTENSIONS = new Set([...MATERIAL_EXTENSIONS, 'KHR_texture_transform', 'KHR_mesh_quantization', 'EXT_texture_webp']);
const COMPONENTS = new Map([[5120, 1], [5121, 1], [5122, 2], [5123, 2], [5125, 4], [5126, 4]]);
const SHAPES = new Map([['SCALAR', [1, 1]], ['VEC2', [1, 2]], ['VEC3', [1, 3]], ['VEC4', [1, 4]],
  ['MAT2', [2, 2]], ['MAT3', [3, 3]], ['MAT4', [4, 4]]]);

function fail(message) { throw new Error(`Garment extraction: ${message}`); }
function integer(value, min = 0) { return Number.isSafeInteger(value) && value >= min; }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function align4(value) { return Math.ceil(value / 4) * 4; }
function abort(signal) {
  if (!signal?.aborted) return;
  const error = new Error('Garment extraction cancelled.');
  error.name = 'AbortError';
  throw error;
}
async function yieldToCaller(signal) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  abort(signal);
}

function table(json, name) {
  const values = json[name] ?? [];
  if (!Array.isArray(values) || values.some((value) => !object(value))) fail(`${name} must be an array of objects.`);
  return values;
}

function indexOf(values, index, label) {
  if (!integer(index) || index >= values.length) fail(`${label} has an invalid source index.`);
  return values[index];
}

function validateExtensions(json) {
  const used = json.extensionsUsed ?? [];
  const required = json.extensionsRequired ?? [];
  for (const list of [used, required]) {
    if (!Array.isArray(list) || list.some((name) => typeof name !== 'string')) fail('extension declarations must be string arrays.');
    const unsupported = list.filter((name) => !EXTENSIONS.has(name));
    if (unsupported.length) fail(`unsupported extensions: ${[...new Set(unsupported)].join(', ')}.`);
  }
  if (required.some((name) => !used.includes(name))) fail('required extensions must also be declared in extensionsUsed.');
  function visit(value, path) {
    if (!value || typeof value !== 'object') return;
    if (value.extensions !== undefined) {
      if (!object(value.extensions)) fail(`${path}.extensions must be an object.`);
      for (const [name, payload] of Object.entries(value.extensions)) {
        if (!EXTENSIONS.has(name) || !used.includes(name)) fail(`unsupported or undeclared extension ${name}.`);
        if (!object(payload)) fail(`${name} must contain an object.`);
        const validPlacement = MATERIAL_EXTENSIONS.has(name) ? /^materials\[\d+\]$/.test(path)
          : name === 'EXT_texture_webp' ? /^textures\[\d+\]$/.test(path)
            : name === 'KHR_texture_transform' && /(?:Texture|TextureInfo)$/.test(path);
        if (!validPlacement) fail(`${name} is not supported at ${path || 'the document root'}.`);
      }
    }
    for (const [key, child] of Object.entries(value)) {
      // Extras are application data, not glTF references or extension declarations.
      if (key === 'extras') continue;
      if (Array.isArray(child)) child.forEach((item, index) => visit(item, `${path ? `${path}.` : ''}${key}[${index}]`));
      else if (child && typeof child === 'object') visit(child, path ? `${path}.${key}` : key);
    }
  }
  visit(json, '');
}

function validateStorage(json, binary) {
  const buffers = table(json, 'buffers');
  if (buffers.length > 1 || buffers.some((buffer) => buffer.uri !== undefined)) fail('only one embedded GLB buffer is supported; resource URIs are not supported.');
  const size = buffers[0]?.byteLength ?? 0;
  if ((buffers.length && !integer(size, 1)) || binary.length < size || binary.length > size + 3) fail('embedded buffer length does not match the binary chunk.');
  const views = table(json, 'bufferViews');
  for (const view of views) {
    if (!buffers.length || view.buffer !== 0 || !integer(view.byteOffset ?? 0) || !integer(view.byteLength, 1)
      || (view.byteOffset ?? 0) + view.byteLength > size) fail('a bufferView exceeds the embedded buffer.');
    if (view.byteStride !== undefined && (!integer(view.byteStride, 4) || view.byteStride > 252 || view.byteStride % 4)) fail('invalid interleaved bufferView stride.');
  }
  for (const image of table(json, 'images')) {
    if (image.uri !== undefined) fail('external and data image URIs are not supported.');
    indexOf(views, image.bufferView, 'Image bufferView');
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(image.mimeType)) fail(`unsupported image type ${image.mimeType}.`);
  }
  return { buffers, views };
}

function accessorLayout(accessor) {
  const componentBytes = COMPONENTS.get(accessor.componentType);
  const shape = SHAPES.get(accessor.type);
  if (!componentBytes || !shape || !integer(accessor.count, 1)) fail('invalid accessor component type, shape, or count.');
  const [columns, rows] = shape;
  const columnBytes = columns > 1 ? align4(rows * componentBytes) : rows * componentBytes;
  return { componentBytes, elementBytes: columns * columnBytes, columns, rows, columnBytes };
}

function viewRange(views, viewIndex, offset, count, elementBytes, componentBytes, interleaved) {
  const view = indexOf(views, viewIndex, 'Accessor bufferView');
  const stride = interleaved ? view.byteStride ?? elementBytes : elementBytes;
  if (!integer(offset) || offset % componentBytes || ((view.byteOffset ?? 0) + offset) % componentBytes
    || stride < elementBytes || (count - 1) * stride + offset + elementBytes > view.byteLength) fail('accessor data exceeds or is misaligned in its bufferView.');
  return { view, stride, start: (view.byteOffset ?? 0) + offset };
}

function readUnsigned(binary, start, type) {
  const view = new DataView(binary.buffer, binary.byteOffset, binary.byteLength);
  return type === 5121 ? view.getUint8(start) : type === 5123 ? view.getUint16(start, true) : view.getUint32(start, true);
}

function validateAccessors(json, views, binary) {
  const accessors = table(json, 'accessors');
  for (const accessor of accessors) {
    const layout = accessorLayout(accessor);
    if (accessor.normalized !== undefined && typeof accessor.normalized !== 'boolean') fail('accessor.normalized must be boolean.');
    if (accessor.normalized && [5125, 5126].includes(accessor.componentType)) fail('this accessor component type cannot be normalized.');
    if (layout.columns > 1 && accessor.bufferView !== undefined
      && ((views[accessor.bufferView]?.byteOffset ?? 0) + (accessor.byteOffset ?? 0)) % 4) fail('matrix accessor columns require four-byte alignment.');
    if (accessor.bufferView !== undefined) viewRange(views, accessor.bufferView, accessor.byteOffset ?? 0,
      accessor.count, layout.elementBytes, layout.componentBytes, true);
    else if (accessor.byteOffset !== undefined) fail('an accessor without a bufferView cannot have a byte offset.');
    if (accessor.sparse !== undefined) {
      const sparse = accessor.sparse;
      if (!object(sparse) || !integer(sparse.count, 1) || sparse.count > accessor.count
        || !object(sparse.indices) || !object(sparse.values) || ![5121, 5123, 5125].includes(sparse.indices.componentType)) fail('invalid sparse accessor.');
      const bytes = COMPONENTS.get(sparse.indices.componentType);
      const indices = viewRange(views, sparse.indices.bufferView, sparse.indices.byteOffset ?? 0, sparse.count, bytes, bytes, false);
      viewRange(views, sparse.values.bufferView, sparse.values.byteOffset ?? 0, sparse.count, layout.elementBytes, layout.componentBytes, false);
      if (layout.columns > 1 && ((views[sparse.values.bufferView].byteOffset ?? 0) + (sparse.values.byteOffset ?? 0)) % 4) fail('sparse matrix values require four-byte alignment.');
      let previous = -1;
      for (let index = 0; index < sparse.count; index++) {
        const vertex = readUnsigned(binary, indices.start + index * bytes, sparse.indices.componentType);
        if (vertex <= previous || vertex >= accessor.count) fail('sparse accessor indices must be increasing and within the accessor.');
        previous = vertex;
      }
    }
  }
  return accessors;
}

/** Read authored values only for bounds/ownership validation; emission copies their original bytes. */
function accessorReader(accessors, views, binary) {
  const cache = new Map();
  const data = new DataView(binary.buffer, binary.byteOffset, binary.byteLength);
  function numberAt(offset, type, normalized) {
    const value = type === 5120 ? data.getInt8(offset) : type === 5121 ? data.getUint8(offset)
      : type === 5122 ? data.getInt16(offset, true) : type === 5123 ? data.getUint16(offset, true)
        : type === 5125 ? data.getUint32(offset, true) : data.getFloat32(offset, true);
    if (!normalized || type === 5126 || type === 5125) return value;
    return type === 5120 ? Math.max(-1, value / 127) : type === 5121 ? value / 255
      : type === 5122 ? Math.max(-1, value / 32767) : value / 65535;
  }
  return function read(index, vertex) {
    if (!cache.has(index)) {
      const accessor = indexOf(accessors, index, 'Vertex accessor');
      const layout = accessorLayout(accessor);
      const base = accessor.bufferView === undefined ? null : viewRange(views, accessor.bufferView,
        accessor.byteOffset ?? 0, accessor.count, layout.elementBytes, layout.componentBytes, true);
      const sparse = new Map();
      if (accessor.sparse) {
        const spec = accessor.sparse;
        const bytes = COMPONENTS.get(spec.indices.componentType);
        const indices = viewRange(views, spec.indices.bufferView, spec.indices.byteOffset ?? 0, spec.count, bytes, bytes, false);
        const values = viewRange(views, spec.values.bufferView, spec.values.byteOffset ?? 0,
          spec.count, layout.elementBytes, layout.componentBytes, false);
        for (let item = 0; item < spec.count; item++) sparse.set(readUnsigned(binary,
          indices.start + item * bytes, spec.indices.componentType), values.start + item * layout.elementBytes);
      }
      cache.set(index, { accessor, layout, base, sparse });
    }
    const { accessor, layout, base, sparse } = cache.get(index);
    const offset = sparse.get(vertex) ?? (base ? base.start + vertex * base.stride : undefined);
    const result = [];
    for (let column = 0; column < layout.columns; column++) for (let row = 0; row < layout.rows; row++) {
      result.push(offset === undefined ? 0 : numberAt(offset + column * layout.columnBytes + row * layout.componentBytes,
        accessor.componentType, accessor.normalized));
    }
    return result;
  };
}

function sourceHierarchy(nodes) {
  const parents = new Map();
  nodes.forEach((node, parent) => {
    for (const [field, length] of [['translation', 3], ['rotation', 4], ['scale', 3], ['matrix', 16]]) {
      if (node[field] !== undefined && (!Array.isArray(node[field]) || node[field].length !== length
        || node[field].some((value) => typeof value !== 'number' || !Number.isFinite(value)))) fail(`node ${field} is invalid.`);
    }
    if (node.matrix && (node.translation || node.rotation || node.scale)) fail('nodes cannot define both matrix and TRS transforms.');
    if (node.children !== undefined && !Array.isArray(node.children)) fail('node children must be an array.');
    for (const child of node.children ?? []) {
      indexOf(nodes, child, 'Node child');
      if (parents.has(child)) fail('nodes must have only one parent.');
      parents.set(child, parent);
    }
  });
  for (let index = 0; index < nodes.length; index++) {
    const visited = new Set();
    for (let current = index; current !== undefined; current = parents.get(current)) {
      if (visited.has(current)) fail('node hierarchy contains a cycle.');
      visited.add(current);
    }
  }
  return parents;
}

function validateSelections(json, options) {
  const nodes = table(json, 'nodes');
  const meshes = table(json, 'meshes');
  const selections = options?.selections;
  if (!Array.isArray(selections) || !selections.length) fail('select at least one source node primitive.');
  const selected = new Map();
  for (const selection of selections) {
    const node = indexOf(nodes, selection?.nodeIndex, 'Selected node');
    const mesh = indexOf(meshes, node.mesh, 'Selected node mesh');
    if (selected.has(selection.nodeIndex)) fail('a source node may only occur once in selections.');
    if (!Array.isArray(mesh.primitives) || !Array.isArray(selection.primitiveIndices) || !selection.primitiveIndices.length) fail('select at least one primitive of each node.');
    const indices = new Set();
    for (const index of selection.primitiveIndices) {
      indexOf(mesh.primitives, index, 'Selected primitive');
      if (indices.has(index)) fail('selected primitive indices must be unique.');
      indices.add(index);
    }
    selected.set(selection.nodeIndex, indices);
  }
  const owned = options.ownedBoneNodeIndices ?? [];
  if (!Array.isArray(owned) || owned.some((index) => !integer(index) || index >= nodes.length) || new Set(owned).size !== owned.length) fail('ownedBoneNodeIndices must contain unique source node indices.');
  return { nodes, meshes, selected, owned: new Set(owned) };
}

function serializeGlb(json, binary) {
  const encoded = new TextEncoder().encode(JSON.stringify(json));
  const jsonSize = align4(encoded.length);
  const binSize = align4(binary.length);
  const output = new Uint8Array(20 + jsonSize + (binary.length ? 8 + binSize : 0));
  const view = new DataView(output.buffer);
  [0x46546c67, 2, output.length, jsonSize, 0x4e4f534a].forEach((value, index) => view.setUint32(index * 4, value, true));
  output.fill(32, 20, 20 + jsonSize);
  output.set(encoded, 20);
  if (binary.length) {
    view.setUint32(20 + jsonSize, binSize, true);
    view.setUint32(24 + jsonSize, 0x004e4942, true);
    output.set(binary, 28 + jsonSize);
  }
  return output;
}

/** Extract source-file node primitives without resampling, optimization, or a live-pose export. */
export async function extractGarmentModel(source, options) {
  abort(options?.signal);
  const { json, binary } = readGlbSource(source, 'Garment Model');
  if (json.asset.minVersion !== undefined && json.asset.minVersion !== '2.0') fail('only glTF 2.0 minimum versions are supported.');
  validateExtensions(json);
  const { buffers, views } = validateStorage(json, binary);
  const accessors = validateAccessors(json, views, binary);
  const { nodes, meshes, selected, owned } = validateSelections(json, options);
  const signal = options.signal;
  const parents = sourceHierarchy(nodes);
  const skins = table(json, 'skins');
  const keptNodes = new Set();
  const keptSkins = new Set();
  const joints = new Set();
  function retainAncestors(index) {
    for (let current = index; current !== undefined; current = parents.get(current)) keptNodes.add(current);
  }
  for (const nodeIndex of selected.keys()) {
    retainAncestors(nodeIndex);
    const skinIndex = nodes[nodeIndex].skin;
    if (skinIndex === undefined) continue;
    const skin = indexOf(skins, skinIndex, 'Selected node skin');
    if (!Array.isArray(skin.joints) || !skin.joints.length || new Set(skin.joints).size !== skin.joints.length) fail('skin joints must be a nonempty unique node list.');
    keptSkins.add(skinIndex);
    for (const joint of skin.joints) {
      indexOf(nodes, joint, 'Skin joint');
      joints.add(joint);
      retainAncestors(joint);
    }
    if (skin.skeleton !== undefined) { indexOf(nodes, skin.skeleton, 'Skin skeleton'); retainAncestors(skin.skeleton); }
    if (skin.inverseBindMatrices !== undefined) {
      const accessor = indexOf(accessors, skin.inverseBindMatrices, 'Skin inverse bind matrices');
      if (accessor.type !== 'MAT4' || accessor.componentType !== 5126 || accessor.normalized || accessor.count !== skin.joints.length) fail('skin inverse bind matrices must contain one float MAT4 per joint.');
    }
  }
  function parentJoint(index) {
    let current = parents.get(index);
    while (current !== undefined && !joints.has(current)) current = parents.get(current);
    return current;
  }
  function ownedBranchRoot(index) {
    let current = index;
    while (owned.has(parentJoint(current))) current = parentJoint(current);
    return current;
  }
  for (const index of owned) {
    if (!joints.has(index)) fail('a garment-owned bone must be a joint in a selected skin.');
    let current = index;
    while (owned.has(current)) {
      current = parentJoint(current);
      if (current === undefined) fail('a garment-owned bone chain requires a shared parent joint.');
    }
  }
  const readElement = accessorReader(accessors, views, binary);
  const selectedInfluences = new Set();
  const otherInfluences = new Set();
  function inspectPrimitive(primitive, skin, influences) {
    if (!object(primitive) || !object(primitive.attributes)) fail('selected primitives require vertex attributes.');
    const position = indexOf(accessors, primitive.attributes.POSITION, 'Position accessor');
    if (position.type !== 'VEC3') fail('POSITION must be a VEC3 accessor.');
    if (primitive.mode !== undefined && (!integer(primitive.mode) || primitive.mode > 6)) fail('invalid primitive mode.');
    if (primitive.targets !== undefined && !Array.isArray(primitive.targets)) fail('morph targets must be an array.');
    for (const streams of [primitive.attributes, ...(primitive.targets ?? [])]) {
      if (!object(streams)) fail('primitive vertex streams must be objects.');
      for (const [semantic, index] of Object.entries(streams)) {
        const accessor = indexOf(accessors, index, `${semantic} accessor`);
        if (accessor.count !== position.count) fail('selected primitive vertex streams have different counts.');
        const layout = accessorLayout(accessor);
        if (accessor.bufferView !== undefined) {
          const view = views[accessor.bufferView];
          if (((view.byteOffset ?? 0) + (accessor.byteOffset ?? 0)) % 4
            || (view.byteStride ?? layout.elementBytes) % 4) fail('vertex attributes require four-byte element alignment.');
        }
        if (accessor.sparse && ((views[accessor.sparse.values.bufferView].byteOffset ?? 0)
          + (accessor.sparse.values.byteOffset ?? 0)) % 4) fail('sparse vertex values require four-byte alignment.');
      }
    }
    let referencedVertices;
    if (primitive.indices !== undefined) {
      const indices = indexOf(accessors, primitive.indices, 'Primitive indices');
      if (indices.type !== 'SCALAR' || indices.normalized || ![5121, 5123, 5125].includes(indices.componentType)) fail('primitive indices must be unsigned integer scalars.');
      referencedVertices = new Set();
      for (let item = 0; item < indices.count; item++) {
        const vertex = readElement(primitive.indices, item)[0];
        if (vertex >= position.count) fail('primitive indices exceed the vertex count.');
        referencedVertices.add(vertex);
      }
    }
    if (!skin) return;
    const semantics = Object.keys(primitive.attributes);
    const sets = semantics.filter((name) => /^(JOINTS|WEIGHTS)_/.test(name));
    if (!sets.includes('JOINTS_0') || !sets.includes('WEIGHTS_0')) fail('skinned primitives require JOINTS_0 and WEIGHTS_0.');
    for (const name of sets) {
      if (!/^(JOINTS|WEIGHTS)_\d+$/.test(name)) fail('invalid skin influence attribute name.');
      const suffix = name.slice(name.indexOf('_') + 1);
      const jointIndex = primitive.attributes[`JOINTS_${suffix}`];
      const weightIndex = primitive.attributes[`WEIGHTS_${suffix}`];
      if (jointIndex === undefined || weightIndex === undefined) fail('each JOINTS set requires a corresponding WEIGHTS set.');
      if (name.startsWith('WEIGHTS')) continue;
      const jointAccessor = accessors[jointIndex];
      const weightAccessor = accessors[weightIndex];
      if (jointAccessor.type !== 'VEC4' || ![5121, 5123].includes(jointAccessor.componentType) || jointAccessor.normalized
        || weightAccessor.type !== 'VEC4' || ![5121, 5123, 5126].includes(weightAccessor.componentType)
        || (weightAccessor.componentType !== 5126 && !weightAccessor.normalized)) fail('invalid joint/weight accessor types.');
      for (let vertex = 0; vertex < position.count; vertex++) {
        const palette = readElement(jointIndex, vertex);
        const weights = readElement(weightIndex, vertex);
        for (let influence = 0; influence < 4; influence++) {
          if (!integer(palette[influence]) || palette[influence] >= skin.joints.length
            || !Number.isFinite(weights[influence]) || weights[influence] < 0 || weights[influence] > 1) fail('invalid joint palette index or weight.');
          if (weights[influence] > 0 && (!referencedVertices || referencedVertices.has(vertex))) influences?.add(skin.joints[palette[influence]]);
        }
      }
    }
  }
  for (const [nodeIndex, primitiveIndices] of selected) {
    const node = nodes[nodeIndex];
    for (const primitiveIndex of primitiveIndices) inspectPrimitive(meshes[node.mesh].primitives[primitiveIndex],
      node.skin === undefined ? null : skins[node.skin], selectedInfluences);
    await yieldToCaller(signal);
  }
  if (owned.size) {
    // Other source instances count too, even when they share the same mesh resource.
    for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex++) {
      const node = nodes[nodeIndex];
      if (node.mesh === undefined || node.skin === undefined) continue;
      const skin = indexOf(skins, node.skin, 'Source skin');
      if (!Array.isArray(skin.joints) || skin.joints.some((index) => !integer(index) || index >= nodes.length)) fail('invalid source skin joints.');
      const mesh = indexOf(meshes, node.mesh, 'Source mesh');
      if (!Array.isArray(mesh.primitives)) fail('source mesh primitives must be an array.');
      mesh.primitives.forEach((primitive, primitiveIndex) => {
        if (!selected.get(nodeIndex)?.has(primitiveIndex)) inspectPrimitive(primitive, skin, otherInfluences);
      });
    }
    const sourceJoints = new Set(skins.flatMap((skin) => skin.joints ?? []));
    const weightedBranches = new Set([...selectedInfluences].filter((index) => owned.has(index)).map(ownedBranchRoot));
    for (const index of owned) {
      if (otherInfluences.has(index)) fail('a garment-owned bone also moves an unselected source primitive.');
      const pending = [...(nodes[index].children ?? [])];
      while (pending.length) {
        const child = pending.pop();
        if (sourceJoints.has(child) && !owned.has(child)) fail('select the complete garment-owned joint chain.');
        pending.push(...(nodes[child].children ?? []));
      }
      // Nonweighted intermediates/leaves are legal within a branch that moves this garment.
      if (!weightedBranches.has(ownedBranchRoot(index))) fail('a garment-owned bone chain must move a selected source primitive.');
      if (nodes[index].extras !== undefined && !object(nodes[index].extras)) fail('garment-owned joint extras must be an object to add ownership metadata.');
    }
  }
  await yieldToCaller(signal);

  const output = { asset: structuredClone(json.asset) };
  if (json.extras !== undefined) output.extras = structuredClone(json.extras);
  const nodeMap = new Map([...keptNodes].sort((a, b) => a - b).map((index, next) => [index, next]));
  const skinMap = new Map([...keptSkins].sort((a, b) => a - b).map((index, next) => [index, next]));
  const chunks = [];
  const outputViews = [];
  let binaryLength = 0;
  function appendView(sourceIndex, data, target) {
    const sourceView = indexOf(views, sourceIndex, 'Retained bufferView');
    const view = { ...structuredClone(sourceView), buffer: 0, byteOffset: binaryLength, byteLength: data.length };
    delete view.byteStride;
    if (target === undefined) delete view.target;
    else view.target = target;
    const index = outputViews.push(view) - 1;
    chunks.push({ start: binaryLength, data });
    binaryLength += align4(data.length);
    return index;
  }
  function copyElements(sourceIndex, offset, count, elementBytes, componentBytes, interleaved) {
    const range = viewRange(views, sourceIndex, offset, count, elementBytes, componentBytes, interleaved);
    const result = new Uint8Array(count * elementBytes);
    for (let element = 0; element < count; element++) result.set(binary.subarray(range.start + element * range.stride,
      range.start + element * range.stride + elementBytes), element * elementBytes);
    return result;
  }
  const accessorMap = new Map();
  const outputAccessors = [];
  const vertexAccessors = new Set();
  for (const [nodeIndex, primitiveIndices] of selected) for (const primitiveIndex of primitiveIndices) {
    const primitive = meshes[nodes[nodeIndex].mesh].primitives[primitiveIndex];
    for (const streams of [primitive.attributes, ...(primitive.targets ?? [])]) {
      for (const index of Object.values(streams)) vertexAccessors.add(index);
    }
  }
  function retainAccessor(index) {
    if (accessorMap.has(index)) return accessorMap.get(index);
    const sourceAccessor = indexOf(accessors, index, 'Retained accessor');
    const accessor = structuredClone(sourceAccessor);
    const layout = accessorLayout(accessor);
    if (accessor.bufferView !== undefined) {
      let data = copyElements(accessor.bufferView, accessor.byteOffset ?? 0,
        accessor.count, layout.elementBytes, layout.componentBytes, true);
      // Quantized VEC2/VEC3 vertex streams still require each vertex to begin on four bytes.
      const stride = vertexAccessors.has(index) ? align4(layout.elementBytes) : layout.elementBytes;
      if (stride !== layout.elementBytes) {
        const aligned = new Uint8Array(accessor.count * stride);
        for (let vertex = 0; vertex < accessor.count; vertex++) aligned.set(data.subarray(vertex * layout.elementBytes,
          (vertex + 1) * layout.elementBytes), vertex * stride);
        data = aligned;
      }
      accessor.bufferView = appendView(accessor.bufferView, data, views[accessor.bufferView].target);
      if (stride !== layout.elementBytes) outputViews[accessor.bufferView].byteStride = stride;
      accessor.byteOffset = 0;
    }
    if (accessor.sparse) {
      const sparse = accessor.sparse;
      const bytes = COMPONENTS.get(sparse.indices.componentType);
      sparse.indices.bufferView = appendView(sparse.indices.bufferView, copyElements(sparse.indices.bufferView,
        sparse.indices.byteOffset ?? 0, sparse.count, bytes, bytes, false));
      sparse.indices.byteOffset = 0;
      sparse.values.bufferView = appendView(sparse.values.bufferView, copyElements(sparse.values.bufferView,
        sparse.values.byteOffset ?? 0, sparse.count, layout.elementBytes, layout.componentBytes, false));
      sparse.values.byteOffset = 0;
    }
    const mapped = outputAccessors.push(accessor) - 1;
    accessorMap.set(index, mapped);
    return mapped;
  }

  const materials = table(json, 'materials');
  const textures = table(json, 'textures');
  const images = table(json, 'images');
  const samplers = table(json, 'samplers');
  const materialMap = new Map();
  const textureMap = new Map();
  const imageMap = new Map();
  const samplerMap = new Map();
  function retainImage(index) {
    if (imageMap.has(index)) return imageMap.get(index);
    const image = structuredClone(indexOf(images, index, 'Texture image'));
    const view = views[image.bufferView];
    image.bufferView = appendView(image.bufferView, binary.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength));
    output.images ??= [];
    const mapped = output.images.push(image) - 1;
    imageMap.set(index, mapped);
    return mapped;
  }
  function retainTexture(index) {
    if (textureMap.has(index)) return textureMap.get(index);
    const texture = structuredClone(indexOf(textures, index, 'Material texture'));
    if (texture.source !== undefined) texture.source = retainImage(texture.source);
    const webp = texture.extensions?.EXT_texture_webp;
    if (webp) webp.source = retainImage(webp.source);
    if (texture.source === undefined && !webp) fail('a retained texture has no image source.');
    if (texture.sampler !== undefined) {
      if (!samplerMap.has(texture.sampler)) {
        output.samplers ??= [];
        samplerMap.set(texture.sampler, output.samplers.push(structuredClone(indexOf(samplers, texture.sampler, 'Texture sampler'))) - 1);
      }
      texture.sampler = samplerMap.get(texture.sampler);
    }
    output.textures ??= [];
    const mapped = output.textures.push(texture) - 1;
    textureMap.set(index, mapped);
    return mapped;
  }
  function retainMaterial(index) {
    if (materialMap.has(index)) return materialMap.get(index);
    const material = structuredClone(indexOf(materials, index, 'Primitive material'));
    function remapTextures(value) {
      for (const [key, child] of Object.entries(value)) {
        if (key === 'extras') continue;
        if (key.endsWith('Texture') && object(child)) {
          child.index = retainTexture(child.index);
        } else if (object(child)) remapTextures(child);
      }
    }
    remapTextures(material);
    output.materials ??= [];
    const mapped = output.materials.push(material) - 1;
    materialMap.set(index, mapped);
    return mapped;
  }

  output.meshes = [];
  output.nodes = [];
  for (const [sourceIndex, mapped] of nodeMap) {
    abort(signal);
    const node = structuredClone(nodes[sourceIndex]);
    // Caller-owned classification is authoritative; donor flags cannot mark shared rig bones.
    if (object(node.extras)) delete node.extras.loomlargeGarmentBone;
    if (owned.has(sourceIndex)) node.extras = { ...(object(node.extras) ? node.extras : {}), loomlargeGarmentBone: true };
    if (node.children) node.children = node.children.filter((index) => nodeMap.has(index)).map((index) => nodeMap.get(index));
    delete node.camera;
    delete node.mesh;
    delete node.skin;
    delete node.weights;
    if (selected.has(sourceIndex)) {
      const sourceNode = nodes[sourceIndex];
      const mesh = structuredClone(meshes[sourceNode.mesh]);
      mesh.primitives = mesh.primitives.filter((_, index) => selected.get(sourceIndex).has(index));
      for (const primitive of mesh.primitives) {
        if (!object(primitive.attributes) || primitive.attributes.POSITION === undefined) fail('selected primitives require POSITION attributes.');
        const count = indexOf(accessors, primitive.attributes.POSITION, 'Position accessor').count;
        for (const streams of [primitive.attributes, ...(primitive.targets ?? [])]) {
          if (!object(streams)) fail('primitive vertex streams must be objects.');
          for (const [semantic, index] of Object.entries(streams)) {
            if (indexOf(accessors, index, `${semantic} accessor`).count !== count) fail('selected primitive vertex streams have different counts.');
            streams[semantic] = retainAccessor(index);
          }
        }
        if (primitive.indices !== undefined) {
          const indices = indexOf(accessors, primitive.indices, 'Primitive indices');
          if (indices.type !== 'SCALAR' || indices.normalized || ![5121, 5123, 5125].includes(indices.componentType)) fail('primitive indices must be unsigned integer scalars.');
          primitive.indices = retainAccessor(primitive.indices);
        }
        if (primitive.material !== undefined) primitive.material = retainMaterial(primitive.material);
      }
      node.mesh = output.meshes.push(mesh) - 1;
      if (sourceNode.skin !== undefined) node.skin = skinMap.get(sourceNode.skin);
      if (sourceNode.weights !== undefined) node.weights = structuredClone(sourceNode.weights);
    }
    output.nodes[mapped] = node;
    if (mapped % 16 === 15) await yieldToCaller(signal);
  }
  if (skinMap.size) output.skins = [...skinMap.keys()].map((index) => {
    const skin = structuredClone(skins[index]);
    skin.joints = skin.joints.map((joint) => nodeMap.get(joint));
    if (skin.skeleton !== undefined) skin.skeleton = nodeMap.get(skin.skeleton);
    if (skin.inverseBindMatrices !== undefined) skin.inverseBindMatrices = retainAccessor(skin.inverseBindMatrices);
    return skin;
  });
  const scenes = table(json, 'scenes');
  output.scenes = scenes.map((scene) => {
    const result = structuredClone(scene);
    if (result.nodes !== undefined && !Array.isArray(result.nodes)) fail('scene nodes must be an array.');
    result.nodes = (result.nodes ?? []).filter((index) => nodeMap.has(index)).map((index) => nodeMap.get(index));
    return result;
  });
  if (!output.scenes.some((scene) => scene.nodes.length)) output.scenes.push({ nodes: [...nodeMap].filter(([index]) => !parents.has(index)).map(([, index]) => index) });
  if (json.scene !== undefined) { indexOf(scenes, json.scene, 'Default scene'); output.scene = json.scene; }
  else output.scene = output.scenes.findIndex((scene) => scene.nodes.length);
  if (output.scenes[output.scene]?.nodes.length === 0) output.scene = output.scenes.findIndex((scene) => scene.nodes.length);
  output.accessors = outputAccessors;
  output.bufferViews = outputViews;
  if (binaryLength) output.buffers = [{ ...structuredClone(buffers[0]), byteLength: binaryLength }];
  if (json.extensionsUsed) output.extensionsUsed = [...json.extensionsUsed];
  if (json.extensionsRequired) output.extensionsRequired = [...json.extensionsRequired];
  const outputBinary = new Uint8Array(binaryLength);
  for (const chunk of chunks) outputBinary.set(chunk.data, chunk.start);
  abort(signal);
  const bytes = serializeGlb(output, outputBinary);
  abort(signal);
  const warnings = json.animations?.length ? ['Garment extraction omits animation clips; source node transforms, skin bind matrices, and morph targets are retained.'] : [];
  return { bytes, warnings };
}
