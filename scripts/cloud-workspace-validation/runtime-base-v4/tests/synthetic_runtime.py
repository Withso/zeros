"""Produce a deterministic test-only runtime with official Node and idle stubs.

This is never part of a base image or an agent/runtime qualification. The caller
fetches the official archive and checksum over HTTPS; no credentials are read.
"""
import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path
import tarfile


def sha(data):
    return hashlib.sha256(data).hexdigest()


def build(node_archive, node_sha256, source_commit, variant, output):
    raw = Path(node_archive).read_bytes()
    assert len(raw) <= 128 * 1024**2 and sha(raw) == node_sha256
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:xz') as archive:
        node = archive.getmember('node-v22.23.1-linux-x64/bin/node')
        assert node.isfile() and 0 < node.size < 256 * 1024**2
        data = archive.extractfile(node).read()
    result = {'version': 1, 'audience': 'zeros-cloud-workspace-setup-result-v1', 'outcome': 'ready'}
    setup = "import fs from 'node:fs';\nconst p=JSON.parse(Buffer.from(fs.readFileSync(0,'utf8'),'base64url').toString());\nif(p.synthetic!==true) process.exit(7);\nprocess.stdout.write(" + json.dumps(json.dumps(result, separators=(',', ':'))) + ");\n"
    contents = {'bin/node': data, 'bin/start-engine.sh': b'#!/bin/sh\nexit 0\n',
                'bin/cloud-engine-namespace': b'#!/bin/sh\nexit 1\n',
                'bin/cloud-process-supervisor': b'#!/bin/sh\nexit 1\n',
                'lib/zeros/cloud-worker-supervisor.mjs': b'setInterval(()=>{},1000);\n',
                'lib/zeros/setup-cloud-workspace.mjs': setup.encode(),
                'lib/zeros/runtime-self-test.mjs': b'process.exit(0);\n',
                'worker/dist-engine/cli.js': b'export {};\n', 'worker/variant.txt': variant.encode()}
    entries = {name: {'path': name, 'type': 'file', 'mode': '0500' if name.endswith('cloud-engine-namespace') else '0555',
                      'size': len(value), 'sha256': sha(value)} for name, value in contents.items()}
    for name in list(entries):
        for parent in Path(name).parents:
            if str(parent) != '.':
                entries[str(parent)] = {'path': str(parent), 'type': 'dir', 'mode': '0755'}
    entries['worker/variant-link.txt'] = {'path': 'worker/variant-link.txt', 'type': 'symlink', 'target': 'variant.txt'}
    tests = Path(__file__).resolve().parent
    shared = tests.parents[3] / 'packages/protocol/src/__tests__/fixtures/cloud-runtime'
    fixtures = shared if shared.is_dir() else tests / 'fixtures/cloud-runtime'
    manifest = json.loads((fixtures / 'manifest.valid.json').read_text())
    manifest['source']['commit'] = source_commit
    manifest['files'] = sorted(entries.values(), key=lambda entry: entry['path'].encode())
    manifest_raw = json.dumps(manifest, separators=(',', ':'), sort_keys=True).encode()
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = output / (variant + '.tar.gz')
    with path.open('wb') as file:
        with gzip.GzipFile(fileobj=file, mode='wb', mtime=0, filename='', compresslevel=9) as gz:
            with tarfile.open(fileobj=gz, mode='w', format=tarfile.PAX_FORMAT) as archive:
                first = tarfile.TarInfo('manifest.json')
                first.size, first.mode = len(manifest_raw), 0o444
                archive.addfile(first, io.BytesIO(manifest_raw))
                for entry in manifest['files']:
                    member = tarfile.TarInfo(entry['path'])
                    if entry['type'] == 'symlink':
                        member.mode, member.type, member.linkname = 0o555, tarfile.SYMTYPE, entry['target']
                    else:
                        member.mode = int(entry['mode'], 8)
                        member.type = tarfile.DIRTYPE if entry['type'] == 'dir' else tarfile.REGTYPE
                    member.size = entry.get('size', 0)
                    archive.addfile(member, io.BytesIO(contents.get(entry['path'], b'')))
    payload = path.read_bytes()
    descriptor = {'runtimeId': 'r1-' + sha(manifest_raw), 'manifestSha256': sha(manifest_raw), 'archiveSha256': sha(payload),
                  'archiveBytes': len(payload), 'expandedBytes': sum(map(len, contents.values())), 'sourceCommit': source_commit,
                  'nodeModulesAbi': 127, 'bootstrapProtocolVersion': 1, 'engineProtocolVersion': 20}
    (output / (variant + '.json')).write_text(json.dumps(descriptor, separators=(',', ':')))
    return descriptor


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--node-archive', required=True)
    parser.add_argument('--node-sha256', required=True)
    parser.add_argument('--source-commit', required=True)
    parser.add_argument('--variant', choices=('a', 'b', 'c'), required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    build(args.node_archive, args.node_sha256, args.source_commit, args.variant, args.output)
