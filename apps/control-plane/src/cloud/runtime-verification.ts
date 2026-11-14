/** This verifier belongs to the control plane, not the archive it inspects.
 * The archive pins the manifest; the manifest pins every executable and module.
 * Rechecking both catches a changed extraction as well as a changed archive. */
export const runtimeVerificationScript = String.raw`
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { lstatSync, openSync, closeSync, readSync, readFileSync, readdirSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const fail = () => { throw new Error('runtime verification failed'); };
const regular = path => { const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink()) fail(); return stat; };
const hash = path => {
  regular(path); const fd = openSync(path, 'r'), digest = createHash('sha256'), buffer = Buffer.alloc(262144);
  try { let n; while ((n = readSync(fd, buffer, 0, buffer.length, null))) digest.update(buffer.subarray(0, n)); }
  finally { closeSync(fd); }
  return digest.digest('hex');
};
try {
  const [root, expected, provided] = process.argv.slice(1);
  if (!root || !/^[a-f0-9]{64}$/.test(expected)) fail();
  const stat = lstatSync(root); if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
  const archive = provided || join(root, '.runtime.tar.gz');
  if (regular(archive).size > 1024 ** 3 || hash(archive) !== expected) fail();
  const member = name => execFileSync('tar', ['-xOzf', archive, './' + name],
    { maxBuffer: 16 * 1024 * 1024, timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
  const manifestBytes = member('runtime-manifest.json');
  regular(join(root, 'runtime-manifest.json'));
  if (!manifestBytes.equals(readFileSync(join(root, 'runtime-manifest.json')))) fail();
  const manifest = JSON.parse(manifestBytes);
  if (manifest.version !== 1 || !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) fail();
  const entries = Object.entries(manifest.files);
  if (!entries.length || entries.length > 100000 || !manifest.files['worker.mjs']) fail();
  const found = new Set(), privateFiles = new Set(['.runtime.tar.gz', '.complete', 'runtime-manifest.json', 'BUILD.json']);
  for (const [name, file] of entries) {
    if (!name || name.includes('\0') || name.split('/').some(part => !part || part === '.' || part === '..') || privateFiles.has(name)) fail();
    const path = join(root, name), info = regular(path);
    if (!file || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || info.size !== file.bytes ||
      (info.mode & 0o022) || hash(path) !== file.sha256) fail();
    found.add(name);
  }
  const walk = (directory, prefix = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isSymbolicLink()) fail();
      if (entry.isDirectory()) walk(join(directory, entry.name), name + '/');
      else if (!entry.isFile() || (!found.has(name) && !privateFiles.has(name))) fail();
    }
  };
  walk(root);
  if (existsSync(join(root, 'BUILD.json')) && !member('BUILD.json').equals(readFileSync(join(root, 'BUILD.json')))) fail();
} catch { process.exitCode = 1; }
`;
