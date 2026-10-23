#!/usr/bin/env node
import { readFile, open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { inspectActorModel, prepareActorModel } from './index.mjs';

const help = `Prepare a new Actor Model without replacing its source.

  embody-prepare-actor --input source.glb --inspect
  embody-prepare-actor --input source.glb --output low.glb --kind low-resolution --ratio 0.5
  embody-prepare-actor --input source.glb --output outfit.glb --kind outfit --remove-mesh mesh:2
  embody-prepare-actor --input source.glb --output bust.glb --kind bust --keep-mesh mesh:0
  embody-prepare-actor --input source.glb --output small.glb --kind miniature --scale 0.25

Kinds: original, optimized, low-resolution, miniature, bust, outfit.
Repeat --remove-mesh or --keep-mesh for multiple source mesh IDs from --inspect.
--max-error limits geometric error relative to primitive extent (default 0.001).
Outputs must not already exist. Bust/outfit operate on whole meshes; they do not
infer garments, cut a combined body, or create new clothing geometry.
`;

const controller = new AbortController();
process.once('SIGINT', () => controller.abort());

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) { process.stdout.write(help); return; }
  const options = { signal: controller.signal };
  let input;
  let output;
  let inspect = false;
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--inspect') { inspect = true; continue; }
    if (!['--input', '--output', '--kind', '--remove-mesh', '--keep-mesh', '--ratio', '--max-error', '--scale'].includes(flag)) {
      throw new Error(`Unknown option ${flag}. Use --help.`);
    }
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
    if (seen.has(flag) && flag !== '--remove-mesh' && flag !== '--keep-mesh') throw new Error(`${flag} may only be provided once.`);
    seen.add(flag);
    if (flag === '--input') input = resolve(value);
    else if (flag === '--output') output = resolve(value);
    else if (flag === '--kind') options.kind = value;
    else if (flag === '--remove-mesh') (options.removeMeshIds ??= []).push(value);
    else if (flag === '--keep-mesh') (options.keepMeshIds ??= []).push(value);
    else if (flag === '--ratio') options.targetRatio = Number(value);
    else if (flag === '--max-error') options.maxError = Number(value);
    else if (flag === '--scale') options.scale = Number(value);
  }
  if (!input) throw new Error('--input is required. Use --help.');
  const source = new Uint8Array(await readFile(input));
  if (inspect) {
    if (output || options.kind) throw new Error('--inspect cannot be combined with --output or --kind.');
    process.stdout.write(`${JSON.stringify(await inspectActorModel(source, options), null, 2)}\n`);
    return;
  }
  if (!output || !options.kind) throw new Error('--output and --kind are required when preparing a Model.');
  if (output === input) throw new Error('Output must differ from the source Model.');
  const result = await prepareActorModel(source, options);
  if (controller.signal.aborted) throw new Error('Actor Model preparation cancelled.');
  // Exclusive creation protects existing files, including source aliases and symlinks.
  const handle = await open(output, 'wx');
  try {
    await handle.writeFile(result.bytes);
  } catch (error) {
    await handle.close();
    await unlink(output);
    throw error;
  }
  await handle.close();
  const { bytes, ...report } = result;
  process.stdout.write(`${JSON.stringify({ output, ...report }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = controller.signal.aborted ? 130 : 1;
});
