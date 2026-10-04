"""Sanitize only an empty, newly built v4 base; never an installed workspace."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys

sys.dont_write_bytecode = True


def sanitize():
    assert os.geteuid() == 0 and len(sys.argv) == 1
    spec = importlib.util.spec_from_file_location('bootstrap', '/opt/zeros-bootstrap/bootstrap.py')
    bootstrap = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bootstrap)
    app = bootstrap.Bootstrap()
    app.base()
    assert json.loads(app.read('/etc/zeros/cloud-worker.json', 4096, 0o444))['version'] == 4
    assert app.current() is None and app.current('previous') is None
    assert set(os.listdir('/opt/zeros-infra')) <= {'.staging'} and not os.listdir('/opt/zeros-infra/.staging')
    assert not os.listdir('/srv/zeros/runtime-installs')

    def remove(target):
        if target.is_symlink() or target.is_file():
            target.unlink()
        elif target.is_dir():
            shutil.rmtree(target)

    for directory in ('/srv/zeros/files', '/srv/zeros/setup', '/srv/zeros/log', '/srv/zeros/state/workspaces',
                      '/srv/zeros/home/agent', '/srv/zeros/home/capture', '/opt/zeros/sessions'):
        for child in Path(directory).iterdir():
            remove(child)
    assert set(os.listdir('/srv/zeros/state')) <= {'workspaces'}
    private = ('.ssh', '.aws', '.azure', '.config/gh', '.config/gcloud', '.config/cursor', '.claude', '.codex', '.cursor',
               '.git-credentials', '.netrc', '.npmrc', '.pypirc', '.bash_history', '.zsh_history')
    for home in ('/root', '/home/user'):
        for name in private:
            remove(Path(home) / name)
        for child in Path(home).glob('.env*'):
            remove(child)
    for child in Path('/tmp').glob('zeros-v2-test-base-*'):
        remove(child)
    remove(Path('/root/zeros-base-v4-builds'))
    app.unlink('/run/zeros/active-runtime.json')
    # Provider-managed OS SSH identity and tools stay under Boat's lifecycle;
    # no workspace or account login grants survive the image capture.
    return {'schema': 'zeros.base-sanitation/v1', 'baseCompatibilityId': app.compat_id, 'clean': True}


if __name__ == '__main__':
    code = 0
    try:
        print(json.dumps(sanitize(), separators=(',', ':')), flush=True)
    except BaseException:
        code = 1
    print(json.dumps({'schema': 'zeros.diagnostic/v1', 'component': 'base', 'stage': 'sanitize', 'ok': code == 0,
                      'exitCode': code, 'timedOut': False, 'failedChecks': [] if code == 0 else ['private_state']}, separators=(',', ':')), flush=True)
    sys.exit(code)
