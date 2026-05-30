import { appendFile, readFile } from 'node:fs/promises';

async function appendOnce(file, marker, text) {
  const content = await readFile(file, 'utf8');
  if (!content.includes(marker)) {
    await appendFile(file, text);
  }
}

await appendOnce(
  'dist/index.js',
  "createAnimationRuntime } from './cljs/index.js'",
  "\nexport { createAnimationRuntime } from './cljs/index.js';\n",
);

await appendOnce(
  'dist/index.d.ts',
  "createAnimationRuntime } from '../types/cljs'",
  "\nexport { createAnimationRuntime } from '../types/cljs';\n",
);

await appendOnce(
  'dist/index.d.cts',
  "createAnimationRuntime } from '../types/cljs'",
  "\nexport { createAnimationRuntime } from '../types/cljs';\n",
);

await appendOnce(
  'dist/index.cjs',
  'createAnimationRuntime is only available from the ESM package entrypoint',
  `
function createAnimationRuntime() {
  throw new Error('createAnimationRuntime is only available from the ESM package entrypoint.');
}
exports.createAnimationRuntime = createAnimationRuntime;
`,
);
