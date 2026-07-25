import { defineConfig } from 'tsup';

/**
 * Build the public Wasm entry before the runtime entries.
 *
 * Keeping this in a separate invocation prevents two tsup declaration builds
 * from cleaning and writing the same dist directory concurrently.
 */
export default defineConfig({
  entry: {
    wasm: 'src/wasm.ts',
  },
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  treeshake: true,
  splitting: false,
  sourcemap: true,
});
