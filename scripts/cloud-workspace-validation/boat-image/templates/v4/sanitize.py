"""Sanitize only an empty, newly built v4 base; never an installed workspace."""
import sys
sys.dont_write_bytecode = True

import importlib.util
import json
import os


def sanitize():
    assert os.geteuid() == 0 and len(sys.argv) == 1
    spec = importlib.util.spec_from_file_location('bootstrap', '/opt/zeros-bootstrap/bootstrap.py')
    bootstrap = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bootstrap)
    app = bootstrap.Bootstrap()
    try:
        app.base()
        app.wait_ready()
        with app.lock('runtime-install.lock'), app.lock('runtime-publication.lock'):
            return sanitize_base(app)
    except BaseException as error:
        app.log_failure(error, stage='sanitize')
        raise


def sanitize_base(app):
    assert json.loads(app.read('/etc/zeros/cloud-worker.json', 4096, 0o444))['version'] == 4
    assert app.current() is None and app.current('previous') is None
    assert set(os.listdir(app.path('/opt/zeros-infra'))) <= {'.staging'} and not os.listdir(app.path('/opt/zeros-infra/.staging'))
    assert not os.listdir(app.path('/srv/zeros/runtime-installs'))

    # app.base() verified this protected helper before sanitation. Use the
    # same descriptor-bound overwrite policy as installed Computer builds.
    spec = importlib.util.spec_from_file_location('computer_build', app.path('/opt/zeros-bootstrap/computer-build.py'))
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    state = helper.ComputerBuild(app.root, uid=app.uid, gid=app.gid)
    state.empty_private_state()
    # The base has no selected repositories. Keep bind-source identities while
    # clearing their contents; Computer sanitation preserves its selected repos.
    state.clear_directory('/srv/zeros/files/repos')
    for child in app.path('/tmp').glob('zeros-v2-test-base-*'):
        state.empty_path('/' + str(child.relative_to(app.root)))
    state.empty_path('/root/zeros-base-v4-builds')
    os.sync()
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
