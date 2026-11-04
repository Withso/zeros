import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
const revision = 'b3f7105390ff9339f55a245646a2bcff51e0f49d';
const paths = new Set(execFileSync('git', ['ls-tree', '-r', '--name-only', revision], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim().split('\n'));
const sources = new Map();
const entry = `export { CloudV2WorkerFrameSchema, CloudV2WorkerHistorySchema, CloudV2ControlFrameSchema } from './packages/protocol/src/cloud-v2-relay.ts';
export { CloudV2PromptOutcomeSchema, CloudV2PromptStatusSchema } from './packages/protocol/src/cloud-v2-prompts.ts';
export { applyUpdate } from './packages/protocol/src/agent-messages.ts';
export { parseInboundBridgeWebSocketFrame } from './apps/desktop/src/renderer/platform/bridge/runtime-client.ts';
export { cloudIncoming } from './apps/desktop/src/renderer/platform/bridge/cloud-runtime-wire.ts';
export { fromPersistedMessage } from './apps/desktop/src/renderer/features/agent/agent-history-client.ts';`;
const result = await build({ stdin: { contents: entry, sourcefile: 'previous-cloud-decoders.ts', loader: 'ts' }, bundle: true,
  format: 'esm', target: 'es2022', write: false, metafile: true, treeShaking: true,
  plugins: [{ name: 'pinned-repository', setup(api) {
    api.onResolve({ filter: /.*/ }, args => {
      let value;
      if (args.path.startsWith('@zeros/protocol/')) value = 'packages/protocol/src/' + args.path.slice('@zeros/protocol/'.length);
      else if (args.path.startsWith('@/')) value = 'apps/desktop/src/' + args.path.slice(2);
      else if (args.path.startsWith('.')) value = path.posix.normalize(path.posix.join(path.posix.dirname(args.importer || '.'), args.path));
      else return { path: args.path, external: true, sideEffects: false };
      const candidates = [value, value + '.ts', value + '.tsx', value + '/index.ts', value + '/index.tsx'];
      const selected = candidates.find(candidate => paths.has(candidate));
      if (!selected) return { path: args.path, external: true, sideEffects: false };
      return { path: selected, namespace: 'previous', sideEffects: false };
    });
    api.onLoad({ filter: /.*/, namespace: 'previous' }, args => {
      const contents = execFileSync('git', ['show', `${revision}:${args.path}`], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
      sources.set(args.path, createHash('sha256').update(contents).digest('hex'));
      return { contents, loader: args.path.endsWith('.tsx') ? 'tsx' : args.path.endsWith('.json') ? 'json' : 'ts' };
    });
  } }],
});
const directory = 'apps/desktop/src/renderer/platform/bridge/__tests__/fixtures';
mkdirSync(directory, { recursive: true });
const code = `// Generated from Withso/zeros ${revision} (MIT). Do not edit.\n// See previous-cloud-decoders.provenance.json for source hashes.\n/* eslint-disable no-undef, @typescript-eslint/no-unused-vars, no-control-regex -- Preserve the frozen legacy decoder code. */\n` + result.outputFiles[0].text;
writeFileSync(`${directory}/previous-cloud-decoders.mjs`, code);
const retained = Object.entries(result.metafile.outputs).flatMap(([, output]) => Object.entries(output.inputs).filter(([, info]) => info.bytesInOutput > 0).map(([name]) => name.replace(/^previous:/, ''))).filter(name => sources.has(name));
writeFileSync(`${directory}/previous-cloud-decoders.provenance.json`, JSON.stringify({ repository: 'https://github.com/Withso/zeros', revision, license: 'MIT', exports: entry, sha256: createHash('sha256').update(code).digest('hex'), sources: [...new Set(retained)].sort().map(name => ({ path: name, sha256: sources.get(name) })) }, null, 2) + '\n');
console.log(JSON.stringify({ revision, bytes: Buffer.byteLength(code), retainedSources: retained.length, loadedSources: sources.size }));
