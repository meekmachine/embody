#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

function usage() {
  console.error([
    'Usage:',
    '  node scripts/extract-humanoid-skeleton-template.cjs <input.glb> <output.json> --id <template-id> --source-character-id <character-id> [--skin-name <name> | --skin-index <index>]',
    '',
    'Example:',
    '  node scripts/extract-humanoid-skeleton-template.cjs ../LoomLarge/frontend/public/characters/jonathan_new.glb src/skeletonTemplates/data/jonathan-cc-base.json --id jonathan-cc-base --source-character-id jonathan --skin-name Armature',
  ].join('\n'));
}

function parseArgs(argv) {
  const [, , inputPath, outputPath, ...rest] = argv;
  const options = {};

  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new Error(`Invalid option ${key ?? ''}`.trim());
    }
    options[key.slice(2)] = value;
    index += 1;
  }

  return { inputPath, outputPath, options };
}

function readGlbJson(filePath) {
  const buffer = fs.readFileSync(filePath);
  if (buffer.toString('utf8', 0, 4) !== 'glTF') {
    throw new Error(`${filePath} is not a binary glTF file`);
  }

  const version = buffer.readUInt32LE(4);
  if (version !== 2) {
    throw new Error(`Unsupported glTF version ${version}; expected 2`);
  }

  const totalLength = buffer.readUInt32LE(8);
  let offset = 12;
  while (offset < totalLength) {
    const length = buffer.readUInt32LE(offset);
    const type = buffer.toString('utf8', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'JSON') {
      return JSON.parse(data.toString('utf8').trim());
    }
    offset += 8 + length;
  }

  throw new Error(`${filePath} has no JSON chunk`);
}

function selectSkin(json, options) {
  const skins = json.skins ?? [];
  if (skins.length === 0) {
    throw new Error('Input GLB has no skins');
  }

  if (options['skin-index'] !== undefined) {
    const skinIndex = Number.parseInt(options['skin-index'], 10);
    if (!Number.isInteger(skinIndex) || skinIndex < 0 || skinIndex >= skins.length) {
      throw new Error(`Invalid --skin-index ${options['skin-index']}`);
    }
    return skins[skinIndex];
  }

  if (options['skin-name']) {
    const skin = skins.find((candidate) => candidate.name === options['skin-name']);
    if (!skin) {
      throw new Error(`No skin named ${options['skin-name']}`);
    }
    return skin;
  }

  return skins[0];
}

function buildParentByNodeIndex(nodes) {
  const parentByNodeIndex = new Map();
  for (const [parentIndexText, node] of Object.entries(nodes)) {
    const parentIndex = Number(parentIndexText);
    for (const childIndex of node.children ?? []) {
      parentByNodeIndex.set(childIndex, parentIndex);
    }
  }
  return parentByNodeIndex;
}

function localTranslationForNode(node) {
  if (Array.isArray(node.translation)) {
    return node.translation.map((value) => finiteNumber(value));
  }

  if (Array.isArray(node.matrix) && node.matrix.length === 16) {
    return [
      finiteNumber(node.matrix[12]),
      finiteNumber(node.matrix[13]),
      finiteNumber(node.matrix[14]),
    ];
  }

  return [0, 0, 0];
}

function finiteNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Expected finite numeric transform value, received ${value}`);
  }
  return value;
}

function extractTemplate(json, inputPath, options) {
  const id = options.id;
  const sourceCharacterId = options['source-character-id'];
  if (!id || !sourceCharacterId) {
    throw new Error('--id and --source-character-id are required');
  }

  const nodes = json.nodes ?? [];
  const skin = selectSkin(json, options);
  const jointNodeIndexes = skin.joints ?? [];
  if (jointNodeIndexes.length === 0) {
    throw new Error(`Selected skin ${skin.name ?? '<unnamed>'} has no joints`);
  }

  const jointIndexSet = new Set(jointNodeIndexes);
  const parentByNodeIndex = buildParentByNodeIndex(nodes);

  const bones = jointNodeIndexes.map((nodeIndex) => {
    const node = nodes[nodeIndex];
    if (!node) {
      throw new Error(`Skin references missing node ${nodeIndex}`);
    }
    if (!node.name) {
      throw new Error(`Joint node ${nodeIndex} has no name`);
    }

    const parentIndex = parentByNodeIndex.get(nodeIndex);
    const parent = jointIndexSet.has(parentIndex)
      ? nodes[parentIndex]?.name ?? null
      : null;

    return {
      name: node.name,
      parent,
      translation: localTranslationForNode(node),
    };
  });

  return {
    id,
    sourceCharacterId,
    sourceAsset: path.relative(process.cwd(), path.resolve(inputPath)),
    sourceSkinName: skin.name ?? `skin-${(json.skins ?? []).indexOf(skin)}`,
    bones,
  };
}

try {
  const { inputPath, outputPath, options } = parseArgs(process.argv);
  if (!inputPath || !outputPath) {
    usage();
    process.exit(1);
  }

  const json = readGlbJson(inputPath);
  const template = extractTemplate(json, inputPath, options);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(template, null, 2)}\n`);

  console.log(`Wrote skeleton template: ${outputPath}`);
  console.log(`Template id: ${template.id}`);
  console.log(`Source skin: ${template.sourceSkinName}`);
  console.log(`Bones: ${template.bones.length}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  usage();
  process.exit(1);
}
