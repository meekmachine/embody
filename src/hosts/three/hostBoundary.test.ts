import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const hostDir = path.dirname(fileURLToPath(import.meta.url));

describe('hosts/three boundary', () => {
  it('RustEmbodyHost and frameBindings do not import Embody.ts', async () => {
    const files = ['RustEmbodyHost.ts', 'frameBindings.ts'];
    for (const file of files) {
      const source = await readFile(path.join(hostDir, file), 'utf8');
      expect(source, file).not.toMatch(/from ['"][^'"]*Embody(?:\.ts)?['"]/);
      expect(source, file).not.toMatch(/engines\/three\/Embody/);
    }
  });
});
