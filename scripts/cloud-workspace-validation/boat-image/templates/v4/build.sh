#!/bin/bash
set -euo pipefail
umask 077
cd -- "$(dirname -- "$0")"

# This profile starts from Boat stock, never a legacy Zeros snapshot.
python3 -I - <<'PY'
import os, pathlib, platform
release = dict(line.split('=', 1) for line in pathlib.Path('/etc/os-release').read_text().splitlines() if '=' in line)
assert os.geteuid() == 0 and platform.machine() == 'x86_64'
assert release['ID'].strip('"') == 'ubuntu' and release['VERSION_ID'].strip('"') == '24.04'
assert not pathlib.Path('/etc/zeros/cloud-worker.json').exists()
assert pathlib.Path('/sys/fs/cgroup/cgroup.controllers').is_file()
PY

export DEBIAN_FRONTEND=noninteractive
apt-get update
# Namespace/ZSR/Git/SSH packages mirror ../Dockerfile and image.ts. The Noble
# browser packages mirror Playwright's Ubuntu 24.04 Chromium nativeDeps list;
# browsers and the verified Node/engine payload belong to the runtime bundle.
apt-get install -y --no-install-recommends \
  acl apparmor bubblewrap busybox-static ca-certificates crun curl file g++ git git-lfs gnupg \
  inotify-tools make openssh-client openssh-sftp-server podman procps python3 ripgrep \
  slirp4netns socat uidmap unzip util-linux xz-utils \
  libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libatspi2.0-0t64 libcairo2 libcups2t64 \
  libdbus-1-3 libdrm2 libgbm1 libglib2.0-0t64 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 \
  libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 xvfb \
  fonts-noto-color-emoji fonts-unifont libfontconfig1 libfreetype6 xfonts-cyrillic xfonts-scalable \
  fonts-liberation fonts-ipafont-gothic fonts-wqy-zenhei fonts-tlwg-loma-otf fonts-freefont-ttf

install -d -o root -g root -m 0755 /srv/zeros /srv/zeros/home /srv/zeros/files
groupadd --gid 10001 zeros-agent
useradd --uid 10001 --gid 10001 --no-create-home --home-dir /srv/zeros/home/agent --shell /bin/bash zeros-agent
usermod --add-subuids 100000-165535 --add-subgids 100000-165535 zeros-agent
groupadd --gid 10002 zeros-capture
useradd --uid 10002 --gid 10002 --no-create-home --home-dir /srv/zeros/home/capture --shell /usr/sbin/nologin zeros-capture
groupadd --gid 10003 zeros-engine
useradd --uid 10003 --gid 10003 --no-create-home --shell /usr/sbin/nologin zeros-engine
groupadd --gid 10004 zeros-coordinator
useradd --uid 10004 --gid 10004 --no-create-home --shell /usr/sbin/nologin zeros-coordinator
install -d -o 10001 -g 10001 -m 0755 /srv/zeros/home/agent
install -d -o 10002 -g 10002 -m 0700 /srv/zeros/home/capture
install -d -o 10003 -g 10003 -m 0700 /srv/zeros/state /srv/zeros/state/workspaces
install -d -o root -g 10001 -m 0750 /srv/zeros/log /srv/zeros/managed-settings
install -o root -g 10001 -m 0640 /dev/null /srv/zeros/managed-settings/settings.managed.toml
install -d -o root -g root -m 0700 /srv/zeros/setup /srv/zeros/runtime-installs /run/zeros
install -d -o root -g root -m 0755 /opt/zeros-bootstrap /opt/zeros-infra /opt/zeros /etc/zeros
for name in bootstrap.py boot.sh dispatch.sh install-runtime.sh; do
  install -o root -g root -m 0555 "base/$name" "/opt/zeros-bootstrap/$name"
done
install -o root -g root -m 0444 base/cloud-worker.json /etc/zeros/cloud-worker.json
install -o root -g root -m 0444 base/zeros-boot.service /etc/systemd/system/zeros-boot.service
install -o root -g root -m 0444 base/zeros-host.service /etc/systemd/system/zeros-host.service
install -o root -g root -m 0444 base/zeros.conf /etc/tmpfiles.d/zeros.conf
install -o root -g root -m 0444 base/zeros-cloud-engine.apparmor /etc/apparmor.d/zeros-cloud-engine

python3 -I - <<'PY'
import hashlib, json, os, pathlib
def raw(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()
def sha(value):
    return hashlib.sha256(value).hexdigest()
protected = ['/opt/zeros-bootstrap/' + name for name in ('bootstrap.py', 'boot.sh', 'dispatch.sh', 'install-runtime.sh')]
protected += ['/etc/zeros/cloud-worker.json', '/etc/systemd/system/zeros-boot.service',
              '/etc/systemd/system/zeros-host.service', '/etc/tmpfiles.d/zeros.conf', '/etc/apparmor.d/zeros-cloud-engine']
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

apparmor_parser -r /etc/apparmor.d/zeros-cloud-engine
systemctl enable apparmor.service zeros-boot.service zeros-host.service
systemd-tmpfiles --create /etc/tmpfiles.d/zeros.conf
systemctl daemon-reload
systemctl start zeros-boot.service zeros-host.service
apt-get clean
rm -rf /var/lib/apt/lists/*
