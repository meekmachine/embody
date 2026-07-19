import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    core: 'src/core/index.ts',
    three: 'src/engines/three/index.ts',
    cljs: 'src/cljs.ts',
    wasm: 'src/wasm.ts',
  },
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  treeshake: true,
  splitting: false,
  sourcemap: true,
});
