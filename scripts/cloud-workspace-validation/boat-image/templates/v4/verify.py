"""Fixed root probe; only version/identity fields and closed checks leave it."""
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
import sys
import time

sys.dont_write_bytecode = True


def verify():
    spec = importlib.util.spec_from_file_location('bootstrap', '/opt/zeros-bootstrap/bootstrap.py')
    bootstrap = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bootstrap)
    app = bootstrap.Bootstrap()
    app.base()
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
        deadline = time.monotonic() + 30
        while True:
            result = subprocess.run(['/usr/bin/systemctl', 'is-active', '--quiet', unit], env=bootstrap.ENV, capture_output=True, timeout=5)
            if result.returncode == 0 or time.monotonic() >= deadline:
                break
            time.sleep(0.2)
        require(result.returncode == 0, 'host_start')
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
    require(not os.path.lexists('/opt/zeros/previous') and not os.path.lexists(bootstrap.ACTIVE), 'cache_conflict')
    require(set(os.listdir('/opt/zeros-infra')) <= {'.staging'} and not os.listdir('/opt/zeros-infra/.staging') and
            not os.listdir('/srv/zeros/runtime-installs'), 'cache_conflict')
    for name in ('/srv/zeros/files', '/srv/zeros/setup', '/srv/zeros/log', '/srv/zeros/home/agent', '/srv/zeros/home/capture'):
        require(not os.listdir(name), 'base_compatibility')
    require(set(os.listdir('/srv/zeros/state')) <= {'workspaces'} and not os.listdir('/srv/zeros/state/workspaces'), 'base_compatibility')
    private = ('.ssh/authorized_keys', '.git-credentials', '.netrc', '.npmrc', '.pypirc', '.bash_history', '.zsh_history',
               '.claude/.credentials.json', '.codex/auth.json', '.cursor/auth.json', '.config/cursor/auth.json')
    for home in ('/root', '/home/user'):
        for name in private:
            target = Path(home) / name
            require(not os.path.lexists(target) or (target.is_file() and target.stat().st_size == 0), 'base_compatibility')
    return {'schema': 'zeros.base-verification/v1', 'baseCompatibilityId': app.compat_id,
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
