import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['three/annotations/__tests__/**/*.test.ts'],
    setupFiles: ['./scripts/test/annotations-setup.ts'],
  },
});
