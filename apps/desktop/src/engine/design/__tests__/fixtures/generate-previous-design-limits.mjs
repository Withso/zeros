// Bundle the Design canvas and page-catalog codecs exactly as the last release
// before per-page frame admission shipped them, for N-1 compatibility tests.
// Run from the repository root: node apps/desktop/src/engine/design/__tests__/fixtures/generate-previous-design-limits.mjs
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
const revision = '2435964e1bdde90623da1042449a6438131f5582';
const paths = new Set(execFileSync('git', ['ls-tree', '-r', '--name-only', revision], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim().split('\n'));
const sources = new Map();
const entry = `export { decodeCanvasFile, encodeCanvasFile } from './apps/desktop/src/engine/design/canvas-file.ts';
export { designPageCatalogSchema } from './packages/protocol/src/design-pages.ts';
export { designCatalogFrameSchema } from './packages/protocol/src/design-catalog.ts';`;
const result = await build({ stdin: { contents: entry, sourcefile: 'previous-design-limits.ts', loader: 'ts' }, bundle: true,
  format: 'esm', platform: 'node', target: 'es2022', write: false, metafile: true, treeShaking: true,
  plugins: [{ name: 'pinned-repository', setup(api) {
    api.onResolve({ filter: /.*/ }, args => {
      let value;
      if (args.path.startsWith('@zeros/protocol/')) value = 'packages/protocol/src/' + args.path.slice('@zeros/protocol/'.length);
      else if (args.path.startsWith('.')) value = path.posix.normalize(path.posix.join(path.posix.dirname(args.importer || '.'), args.path));
      else return { path: args.path, external: true, sideEffects: false };
      const candidates = [value, value + '.ts', value + '/index.ts'];
      const selected = candidates.find(candidate => paths.has(candidate));
      if (!selected) return { path: args.path, external: true, sideEffects: false };
      return { path: selected, namespace: 'previous', sideEffects: false };
    });
    api.onLoad({ filter: /.*/, namespace: 'previous' }, args => {
      const contents = execFileSync('git', ['show', `${revision}:${args.path}`], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
      sources.set(args.path, createHash('sha256').update(contents).digest('hex'));
      return { contents, loader: 'ts' };
    });
  } }],
});
const directory = 'apps/desktop/src/engine/design/__tests__/fixtures';
mkdirSync(directory, { recursive: true });
const code = `// Generated from Withso/zeros ${revision} (MIT). Do not edit.\n// See previous-design-limits.provenance.json for source hashes.\n/* eslint-disable -- Preserve the frozen previous codec. */\n` + result.outputFiles[0].text;
writeFileSync(`${directory}/previous-design-limits.mjs`, code);
const retained = Object.entries(result.metafile.outputs).flatMap(([, output]) => Object.entries(output.inputs).filter(([, info]) => info.bytesInOutput > 0).map(([name]) => name.replace(/^previous:/, ''))).filter(name => sources.has(name));
writeFileSync(`${directory}/previous-design-limits.provenance.json`, JSON.stringify({ repository: 'https://github.com/Withso/zeros', revision, license: 'MIT', exports: entry, sha256: createHash('sha256').update(code).digest('hex'), sources: [...new Set(retained)].sort().map(name => ({ path: name, sha256: sources.get(name) })) }, null, 2) + '\n');
console.log(JSON.stringify({ revision, bytes: Buffer.byteLength(code), retainedSources: retained.length, loadedSources: sources.size }));
