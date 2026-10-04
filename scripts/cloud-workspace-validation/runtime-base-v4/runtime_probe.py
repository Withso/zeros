"""Operator-only runtime proof; transported by the kit, never installed."""
import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import time


def probe_failure(error):
    names = {"AssertionError", "Failure", "FileNotFoundError", "PermissionError", "OSError", "TimeoutError",
             "TimeoutExpired", "CalledProcessError", "ValueError", "TypeError", "KeyError", "RuntimeError", "JSONDecodeError",
             "NotADirectoryError", "IsADirectoryError", "FileExistsError", "BlockingIOError", "InterruptedError", "BrokenPipeError"}
    name = type(error).__name__
    line, trace = 0, error.__traceback__
    while trace is not None:
        if trace.tb_frame.f_code.co_filename == __file__:
            line = trace.tb_lineno
        trace = trace.tb_next
    return {"schema": "zeros.live-probe-failure/v1", "exception": name if name in names else "Exception", "line": line}


def probe(b, app, rid, cold_hash):
    app.wait_ready()
    app.base()
    deadline = time.monotonic() + 30
    while not pathlib.Path(b.ACTIVE).exists() and time.monotonic() < deadline:
        time.sleep(.2)
    assert app.current() == rid
    cold = False
    if cold_hash:
        os.sync()
        try:
            pathlib.Path('/proc/sys/vm/drop_caches').write_text('3')
            cold = True
        except OSError:
            pass
    start = time.monotonic()
    manifest, receipt = app.verify_runtime(rid, full=True)
    elapsed = (time.monotonic() - start) * 1000
    active = json.loads(app.read(b.ACTIVE, 4096, 0o600))
    assert active['runtimeId'] == rid and active['bootId'] == app.boot_id() and active['installerReceiptSha256'] == b.sha(receipt)
    assert app.status()['hostState'] == 'idle'
    node = subprocess.run([b.INFRA + '/' + rid + '/bin/node', '-p', 'JSON.stringify({node:process.versions.node,abi:process.versions.modules})'],
                          env=b.ENV, check=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=10)
    versions = json.loads(node.stdout)
    assert versions == {'node': '22.23.1', 'abi': '127'}
    return {'runtimeId': rid, 'previous': app.current('previous'), 'bootId': app.boot_id(),
            'sessionId': active['supervisorSessionId'], 'fullRehashMs': elapsed, 'coldCache': cold,
            'fileCount': sum(e['type'] == 'file' for e in manifest['files']), 'expandedBytes': sum(e.get('size', 0) for e in manifest['files']),
            'node': versions['node'], 'abi': 127}


def main(runtime_id, cold_hash=False):
    sys.dont_write_bytecode = True
    app, code = None, 1
    try:
        spec = importlib.util.spec_from_file_location('bootstrap', '/opt/zeros-bootstrap/bootstrap.py')
        b = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(b)
        app = b.Bootstrap()
        print(json.dumps(probe(b, app, runtime_id, cold_hash)), flush=True)
        code = 0
    except BaseException as error:
        if app is not None:
            try:
                app.log_failure(error, stage='resume')
            except BaseException:
                pass  # The operator still needs the original probe failure.
        # Only the kit consumes this value. It persists these fixed identities
        # privately and prints only the final closed diagnostic to its caller.
        print(json.dumps(probe_failure(error)), flush=True)
    print(json.dumps({'schema': 'zeros.diagnostic/v1', 'component': 'base', 'stage': 'install', 'ok': code == 0,
                      'exitCode': code, 'timedOut': False, 'failedChecks': [] if code == 0 else ['runtime_install']}), flush=True)
    sys.exit(code)
