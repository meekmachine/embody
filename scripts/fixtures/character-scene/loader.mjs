import { readFile } from 'node:fs/promises';
import ts from 'typescript';

let entry;
let fixture;
export function initialize(data) {
  ({ entry, fixture } = data);
}

export async function resolve(specifier, context, nextResolve) {
  // Only replace the adapter's renderer boundary. Fixtures and Three addons
  // retain the real Three classes, geometry, materials, lights and environments.
  if (specifier === 'three' && context.parentURL === entry) {
    return { url: fixture, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  // A source-only review can run the same cases before the one package build.
  if (url === entry && url.endsWith('.ts')) {
    const source = ts.transpileModule(await readFile(new URL(url), 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
    }).outputText;
    return { format: 'module', source, shortCircuit: true };
  }
  return nextLoad(url, context);
}
