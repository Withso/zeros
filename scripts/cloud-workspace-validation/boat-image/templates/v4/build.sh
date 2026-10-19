#!/bin/bash
set -euo pipefail
umask 077
cd -- "$(dirname -- "$0")"

# This profile starts from Boat stock, never a legacy Zeros snapshot.
python3 -I -B - <<'PY'
import sys
sys.dont_write_bytecode = True
import os, pathlib, platform
release = dict(line.split('=', 1) for line in pathlib.Path('/etc/os-release').read_text().splitlines() if '=' in line)
assert os.geteuid() == 0 and platform.machine() == 'x86_64'
assert release['ID'].strip('"') == 'ubuntu' and release['VERSION_ID'].strip('"') == '24.04'
assert not pathlib.Path('/etc/zeros/cloud-worker.json').exists()
assert pathlib.Path('/sys/fs/cgroup/cgroup.controllers').is_file()
PY

# Stock capabilities and optional systemd ancestry are qualified before any
# base mutation. The owned build directory holds this temporary evidence.
python3 -I -B base/stock-prerequisites.py > stock-prerequisites.json

# Boat stock owns /opt as user:user. Protect the bootstrap's ancestry without
# changing ownership of any provider-managed children under /opt.
chown root:root /opt
chmod 0755 /opt

install -d -o root -g root -m 0755 /srv/zeros
groupadd --gid 10001 zeros-agent
useradd --uid 10001 --gid 10001 --no-log-init --no-create-home --home-dir /srv/zeros/home/agent --shell /bin/bash zeros-agent
usermod --add-subuids 100000-165535 --add-subgids 100000-165535 zeros-agent
groupadd --gid 10002 zeros-capture
useradd --uid 10002 --gid 10002 --no-log-init --no-create-home --home-dir /srv/zeros/home/capture --shell /usr/sbin/nologin zeros-capture
groupadd --gid 10003 zeros-engine
useradd --uid 10003 --gid 10003 --no-log-init --no-create-home --shell /usr/sbin/nologin zeros-engine
groupadd --gid 10004 zeros-coordinator
useradd --uid 10004 --gid 10004 --no-log-init --no-create-home --shell /usr/sbin/nologin zeros-coordinator
# zeros-boot creates mutable data in its Boat-persisted backing directories,
# then binds the logical paths before initializing homes/settings/workspaces.
install -d -o root -g root -m 0700 /srv/zeros/runtime-installs /run/zeros
install -d -o root -g root -m 0755 /opt/zeros-bootstrap /opt/zeros-infra /opt/zeros /etc/zeros
for name in bootstrap.py boot.sh dispatch.sh install-runtime.sh computer-build.py computer-boot-integrity.py computer-build-qualification.py computer-git-askpass.py stock-prerequisites.py; do
  install -o root -g root -m 0555 "base/$name" "/opt/zeros-bootstrap/$name"
done
install -o root -g root -m 0444 stock-prerequisites.json /opt/zeros-bootstrap/stock-prerequisites.json
install -o root -g root -m 0444 base/cloud-worker.json /etc/zeros/cloud-worker.json
install -o root -g root -m 0444 base/zeros-boot.service /etc/systemd/system/zeros-boot.service
install -o root -g root -m 0444 base/zeros-host.service /etc/systemd/system/zeros-host.service
install -o root -g root -m 0444 base/zeros.conf /etc/tmpfiles.d/zeros.conf
install -o root -g root -m 0444 base/zeros-cloud-engine.apparmor /etc/apparmor.d/zeros-cloud-engine
install -d -o root -g root -m 0555 /usr/lib/zeros-runner /usr/lib/zeros-runner/empty /usr/lib/zeros-runner/booted
install -o root -g root -m 0444 base/runner-support.json /usr/lib/zeros-runner/support.json
install -o root -g root -m 0444 base/zeros-runner.target /usr/lib/zeros-runner/zeros-runner.target

python3 -I -B - <<'PY'
import sys
sys.dont_write_bytecode = True
import hashlib, json, os, pathlib
def raw(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()
def sha(value):
    return hashlib.sha256(value).hexdigest()
protected = ['/opt/zeros-bootstrap/' + name for name in ('bootstrap.py', 'boot.sh', 'dispatch.sh', 'install-runtime.sh',
                                                     'computer-build.py', 'computer-boot-integrity.py', 'computer-build-qualification.py', 'computer-git-askpass.py', 'stock-prerequisites.py', 'stock-prerequisites.json')]
protected += ['/etc/zeros/cloud-worker.json', '/etc/systemd/system/zeros-boot.service',
              '/etc/systemd/system/zeros-host.service', '/etc/tmpfiles.d/zeros.conf', '/etc/apparmor.d/zeros-cloud-engine']
protected += ['/usr/lib/zeros-runner/support.json', '/usr/lib/zeros-runner/zeros-runner.target']
compat = json.loads(pathlib.Path('base/compatibility.json').read_bytes())
compat['protectedFiles'] = [{'path': name, 'mode': format(pathlib.Path(name).stat().st_mode & 0o7777, '04o'),
                             'sha256': sha(pathlib.Path(name).read_bytes())} for name in sorted(protected)]
value = raw(compat)
path = pathlib.Path('/opt/zeros-bootstrap/compatibility.json')
path.write_bytes(value)
path.chmod(0o444)
build = {'schema': 'zeros.base-build/v1', 'profile': 'zeros-cloud-worker-v4',
         'sourceCommit': '{{SOURCE_COMMIT}}', 'sourceSha256': '{{BASE_INPUT_SHA256}}',
         'baseCompatibilityId': 'bc1-' + sha(value)}
path = pathlib.Path('/etc/zeros/base-build.json')
path.write_bytes(raw(build))
path.chmod(0o444)
for name in ('/etc/zeros', '/opt/zeros-bootstrap'):
    fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY)
    os.fsync(fd)
    os.close(fd)
PY

# Qualified -K skips both cache reads and writes, including configured -W.
apparmor_parser -r -K /etc/apparmor.d/zeros-cloud-engine
systemctl enable apparmor.service zeros-boot.service zeros-host.service
systemd-tmpfiles --create /etc/tmpfiles.d/zeros.conf
systemctl daemon-reload
systemctl start zeros-boot.service zeros-host.service
