import { defineConfig } from 'tsup';

const shared = {
  treeshake: true,
  splitting: false,
  sourcemap: true,
  external: ['three'],
};

export default defineConfig([
  {
    ...shared,
    entry: {
      index: 'index.ts',
      three: 'three/index.ts',
    },
    format: ['cjs', 'esm'],
    clean: true,
  },
  {
    ...shared,
    entry: { wasm: 'wasm/auto.ts' },
    format: ['esm'],
    target: 'es2022',
  },
  {
    ...shared,
    entry: { wasm: 'wasm/index.ts' },
    format: ['cjs'],
  },
]);
