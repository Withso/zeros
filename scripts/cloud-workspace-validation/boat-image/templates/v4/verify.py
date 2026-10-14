"""Fixed root probe; only public base contract, identities and closed checks leave it."""
import sys
sys.dont_write_bytecode = True

import base64
import contextlib
import grp
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import pwd
import re
import stat
import subprocess

# Boat installs its own root key on every machine during boot. Builder
# sanitation empties it before capture and the kit checks the saved tree, so a
# cold boot from the snapshot may show only the provider's reinstalled key.
COLD_BOOT = '{{BOOT}}' == 'cold'
PRIVATE_FILES = ('.ssh/authorized_keys', '.git-credentials', '.netrc', '.npmrc', '.pypirc', '.bash_history', '.zsh_history',
                 '.claude/.credentials.json', '.codex/auth.json', '.cursor/auth.json', '.config/cursor/auth.json')


def verify_protected_ancestry(app):
    # Check every protected path, including its root and all intermediate
    # directories, with the bootstrap's no-follow ownership/mode checks.
    for entry in app.compat['protectedFiles']:
        with app.directory(entry['path'].rsplit('/', 1)[0] or '/'):
            pass


def private_state_clean(root='/', cold_boot=COLD_BOOT):
    def empty_file(relative):
        def identity(info):
            return info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid, info.st_nlink, info.st_size

        try:
            with contextlib.ExitStack() as stack:
                parent = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
                stack.callback(os.close, parent)
                watches = []
                parts = relative.split('/')
                for index, part in enumerate(parts):
                    try:
                        before = os.stat(part, dir_fd=parent, follow_symlinks=False)
                    except FileNotFoundError:
                        break
                    directory = index < len(parts) - 1
                    if not (stat.S_ISDIR(before.st_mode) if directory else
                            stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_size == 0):
                        return False
                    child = os.open(part, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC |
                                    (os.O_DIRECTORY if directory else 0), dir_fd=parent)
                    stack.callback(os.close, child)
                    watches.append((parent, part, child, identity(before)))
                    parent = child
                return all(identity(os.fstat(fd)) == before and
                           identity(os.stat(name, dir_fd=parent, follow_symlinks=False)) == before
                           for parent, name, fd, before in watches)
        except OSError:
            return False

    for home in ('root', 'home/user'):
        for name in PRIVATE_FILES:
            if cold_boot and home == 'root' and name == '.ssh/authorized_keys':
                continue
            if not empty_file(home + '/' + name):
                return False
    return True


def verify_empty_base_state(bootstrap, app):
    require = bootstrap.require
    require(not os.path.lexists(app.path('/opt/zeros/previous')), 'cache_conflict')
    try:
        require(app.read(bootstrap.ACTIVE, 16384, 0o600) == b'', 'cache_conflict')
    except FileNotFoundError:
        pass
    require(set(os.listdir(app.path('/opt/zeros-infra'))) <= {'.staging'} and
            not os.listdir(app.path('/opt/zeros-infra/.staging')) and
            not os.listdir(app.path('/srv/zeros/runtime-installs')), 'cache_conflict')
    require({'repos', '.zeros-setup', 'state', 'home', 'managed-settings'} <= set(os.listdir(app.path('/srv/zeros/files'))), 'base_compatibility')
    require({'agent', 'capture'} <= set(os.listdir(app.path('/srv/zeros/files/home'))), 'base_compatibility')
    for name in ('/srv/zeros/files', '/srv/zeros/repos', '/srv/zeros/setup', '/srv/zeros/log', '/srv/zeros/home',
                 '/srv/zeros/state', '/srv/zeros/managed-settings'):
        fd = os.open(app.path(name), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try: app.require_empty_directory(fd)
        finally: os.close(fd)


def verify_stock_prerequisites(app):
    # app.base() already verified this helper and the stock evidence against
    # the protected inventory. Repeat the read-only probes on the cold clone.
    spec = importlib.util.spec_from_file_location('stock', app.path('/opt/zeros-bootstrap/stock-prerequisites.py'))
    stock = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(stock)
    expected = json.loads(app.read('/opt/zeros-bootstrap/stock-prerequisites.json', 128 * 1024, 0o444))
    stock.require(stock.probe(app.root, uid=app.uid, gid=app.gid) == expected)


def verify():
    spec = importlib.util.spec_from_file_location('bootstrap', '/opt/zeros-bootstrap/bootstrap.py')
    bootstrap = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bootstrap)
    app = bootstrap.Bootstrap()
    try:
        return verify_host(bootstrap, app)
    except BaseException as error:
        app.log_failure(error, stage='verify')
        raise


def verify_host(bootstrap, app):
    app.base()
    app.wait_ready()
    verify_protected_ancestry(app)
    require = bootstrap.require
    marker = json.loads(app.read('/etc/zeros/cloud-worker.json', 4096, 0o444))
    require(marker == {'backend': 'cloud-worker', 'gid': 10001, 'profile': 'zeros-cloud-worker-v4', 'uid': 10001, 'version': 4}, 'base_compatibility')
    build_raw = app.read('/etc/zeros/base-build.json', 4096, 0o444)
    build = json.loads(build_raw)
    require(build['schema'] == 'zeros.base-build/v1' and build['baseCompatibilityId'] == app.compat_id and
            re.fullmatch('[a-f0-9]{40}', build['sourceCommit']) is not None, 'base_compatibility')
    release = dict(line.split('=', 1) for line in Path('/etc/os-release').read_text().splitlines() if '=' in line)
    require(release['ID'].strip('"') == 'ubuntu' and release['VERSION_ID'].strip('"') == '24.04', 'base_compatibility')
    systemd = subprocess.run(['/usr/bin/systemctl', '--version'], check=True, capture_output=True, env=bootstrap.ENV).stdout.decode().split()[1]
    versions = {'systemd': int(systemd), 'glibc': os.confstr('CS_GNU_LIBC_VERSION').split()[-1],
                'kernel': platform.release(), 'python': platform.python_version(), 'arch': platform.machine()}
    require(versions['systemd'] >= 254 and versions['glibc'] == '2.39' and versions['arch'] == 'x86_64', 'base_compatibility')
    for version in ('glibc', 'kernel', 'python', 'arch'):
        require(re.fullmatch(r'[A-Za-z0-9_.+-]{1,128}', versions[version]) is not None, 'base_compatibility')
    for name, uid in (('agent', 10001), ('capture', 10002), ('engine', 10003), ('coordinator', 10004)):
        user = pwd.getpwnam('zeros-' + name)
        require(user.pw_uid == uid and user.pw_gid == uid and grp.getgrnam('zeros-' + name).gr_gid == uid, 'uid_map')
    for file in ('/etc/subuid', '/etc/subgid'):
        require('zeros-agent:100000:65536' in Path(file).read_text().splitlines(), 'uid_map')
    require(Path('/zeros').is_symlink() and os.readlink('/zeros') == '/opt/zeros', 'pointer_publish')
    require(stat.S_IMODE(Path('/run/zeros').stat().st_mode) == 0o700 and Path('/run/zeros').stat().st_uid == 0, 'root_ownership')
    require('zeros-cloud-engine (unconfined)' in Path('/sys/kernel/security/apparmor/profiles').read_text(), 'apparmor')
    for unit in ('zeros-boot.service', 'zeros-host.service'):
        enabled = subprocess.run(['/usr/bin/systemctl', 'is-enabled', '--quiet', unit], env=bootstrap.ENV, capture_output=True)
        require(enabled.returncode == 0, 'host_start')
    props = subprocess.run(['/usr/bin/systemctl', 'show', '--property=DelegateSubgroup,KillMode,ControlGroup,MainPID', 'zeros-host.service'],
                           env=bootstrap.ENV, check=True, capture_output=True).stdout.decode()
    properties = dict(line.split('=', 1) for line in props.splitlines())
    require(properties['DelegateSubgroup'] == 'host' and properties['KillMode'] == 'control-group' and
            properties['ControlGroup'] == '/system.slice/zeros-host.service', 'cgroup_controllers')
    require(Path('/proc/' + str(int(properties['MainPID'])) + '/cgroup').read_text().strip() ==
            '0::/system.slice/zeros-host.service/host', 'cgroup_controllers')
    scope = Path(bootstrap.CGROUP)
    require(not (scope / 'cgroup.procs').read_text().strip() and
            {'cpu', 'memory', 'pids'} <= set((scope / 'cgroup.subtree_control').read_text().split()), 'cgroup_controllers')
    require((scope / 'host/memory.max').read_text().strip() != 'max' and
            (scope / 'host/pids.max').read_text().strip() != 'max', 'cgroup_controllers')
    status = app.status()
    require(status['hostState'] == 'waiting_for_runtime' and status['currentRuntimeId'] is None, 'host_start')
    verify_empty_base_state(bootstrap, app)
    require(private_state_clean(), 'base_compatibility')
    verify_stock_prerequisites(app)
    compatibility_raw = app.read('/opt/zeros-bootstrap/compatibility.json', 65536, 0o444)
    require('bc1-' + hashlib.sha256(compatibility_raw).hexdigest() == app.compat_id, 'base_compatibility')
    return {'schema': 'zeros.base-verification/v1', 'baseCompatibilityId': app.compat_id,
            'compatibilityRawB64': base64.b64encode(compatibility_raw).decode('ascii'),
            'baseBuildSha256': hashlib.sha256(build_raw).hexdigest(), 'sourceCommit': build['sourceCommit'],
            'versions': versions, 'bootId': status['bootId'], 'hostState': status['hostState'],
            'checks': ['base_compatibility', 'uid_map', 'apparmor', 'cgroup_controllers', 'root_ownership', 'host_start', 'private_state']}


if __name__ == '__main__':
    code, checks = 0, []
    try:
        assert len(sys.argv) == 1 and os.geteuid() == 0
        print(json.dumps(verify(), separators=(',', ':')), flush=True)
    except BaseException as error:
        code = 1
        checks = getattr(error, 'checks', ['base_compatibility'])
    print(json.dumps({'schema': 'zeros.diagnostic/v1', 'component': 'base', 'stage': 'verify', 'ok': code == 0,
                      'exitCode': code, 'timedOut': False, 'failedChecks': checks}, separators=(',', ':')), flush=True)
    sys.exit(code)
