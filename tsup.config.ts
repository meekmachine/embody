import type { Plugin } from 'esbuild';
import { defineConfig } from 'tsup';

const WASM_PACKAGE_ENTRY = '@lovelace_lol/embody/wasm';

/**
 * Keep the Wasm loader as a single runtime singleton.
 *
 * Polymer (and hosts) call `initEmbodyCore` via `@lovelace_lol/embody/wasm`.
 * Sync helpers in the main package (`extendPresetWithProfile`, clip compiler,
 * hair curves, …) must share that same module instance. If tsup bundles
 * `src/wasm.ts` into `dist/index.js`, each entry gets its own `cachedCore`
 * and Polymer init never unlocks the sync helpers.
 */
const externalizeWasmSingleton = (): Plugin => ({
  name: 'externalize-wasm-singleton',
  setup(build) {
    build.onResolve({ filter: /(?:^|\/)wasm$/ }, (args) => {
      if (args.kind === 'entry-point') {
        return undefined;
      }

      // Leave the generated glue import inside src/wasm.ts alone
      // (`./wasm/embody_wasm.js`). Only rewrite the TS module `src/wasm.ts`.
      if (args.path.includes('embody_wasm') || args.path.includes('wasm/')) {
        return undefined;
      }

      return { path: WASM_PACKAGE_ENTRY, external: true };
    });
  },
});

export default defineConfig([
  {
    entry: {
      wasm: 'src/wasm.ts',
    },
    format: ['cjs', 'esm'],
    dts: true,
    clean: true,
    treeshake: true,
    splitting: false,
    sourcemap: true,
  },
  {
    entry: {
      index: 'src/index.ts',
      core: 'src/core/index.ts',
      three: 'src/engines/three/index.ts',
      cljs: 'src/cljs.ts',
    },
    format: ['cjs', 'esm'],
    dts: true,
    clean: false,
    treeshake: true,
    splitting: false,
    sourcemap: true,
    external: [WASM_PACKAGE_ENTRY],
    esbuildPlugins: [externalizeWasmSingleton()],
  },
]);
