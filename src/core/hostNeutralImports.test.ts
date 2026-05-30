/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest';

const THREE_IMPORT_RE = /\bimport\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]three(?:\/[^'"]*)?['"]|\bimport\s*\(\s*['"]three(?:\/[^'"]*)?['"]\s*\)/;
const coreSources = import.meta.glob('./**/*.ts', {
  eager: true,
  import: 'default',
  query: '?raw',
}) as Record<string, string>;

describe('host-neutral core files', () => {
  it('do not import Three.js', () => {
    const offenders = Object.entries(coreSources)
      .filter(([path]) => !path.endsWith('.test.ts'))
      .filter(([, source]) => THREE_IMPORT_RE.test(source))
      .map(([path]) => path);

    expect(offenders).toEqual([]);
  });
});
