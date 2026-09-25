import hashlib
import json
import os
import pathlib
import re
import signal
import subprocess
import sys
import time


def persist(path, value):
    data = (json.dumps(value, sort_keys=True) + '\n').encode()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb', closefd=False) as stream:
            stream.write(data)
            stream.flush()
            os.fsync(fd)
    finally:
        os.close(fd)
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def run_build(job, timeout=1200):
    job = pathlib.Path(job)
    manifest = json.loads((job / 'attempt.json').read_text())
    attempt = manifest['attempt']
    if not re.fullmatch(r'm2-build-[a-f0-9]{32}', attempt) or job.name != attempt:
        raise RuntimeError('Build attempt identity mismatch')
    if hashlib.sha256((job / 'build.sh').read_bytes()).hexdigest() != manifest['scriptSha256']:
        raise RuntimeError('Build script identity mismatch')
    identity = {key: manifest[key] for key in ('attempt', 'sourceCommit', 'archiveSha256', 'scriptSha256')}
    persist(job / 'runner-started.json', {**identity, 'pid': os.getpid(), 'startTicks': pathlib.Path('/proc/self/stat').read_text().split(') ')[1].split()[19]})
    scope = pathlib.Path('/sys/fs/cgroup') / ('zeros-' + attempt)
    scope.mkdir()  # Exclusive: a retry cannot adopt another build's descendants.
    child = None
    code = 125
    failure = None
    retired = False
    interrupted = False

    def request_stop(_signum, _frame):
        nonlocal interrupted
        interrupted = True

    prior = {s: signal.signal(s, request_stop) for s in (signal.SIGTERM, signal.SIGINT)}
    try:
        with (job / 'build.log').open('x') as out:
            def enter_scope():
                (scope / 'cgroup.procs').write_text(str(os.getpid()))
            child = subprocess.Popen(['/bin/bash', str(job / 'build.sh')], stdin=subprocess.DEVNULL,
                                     stdout=out, stderr=subprocess.STDOUT, preexec_fn=enter_scope,
                                     start_new_session=True,
                                     env={'PATH': '/opt/zeros-runtime/bin:/usr/bin:/bin:/usr/sbin:/sbin', 'HOME': '/root'})
            deadline = time.monotonic() + timeout
            while True:
                if interrupted:
                    code = 130
                    break
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    code = 124
                    break
                try:
                    code = child.wait(timeout=min(0.2, remaining))
                    break
                except subprocess.TimeoutExpired:
                    pass
    except BaseException as error:
        failure = type(error).__name__
    finally:
        try:
            (scope / 'cgroup.kill').write_text('1')
            if child is not None:
                child.wait(timeout=10)
            deadline = time.monotonic() + 10
            while 'populated 1' in (scope / 'cgroup.events').read_text():
                if time.monotonic() >= deadline:
                    raise RuntimeError('Owned descendant retirement unconfirmed')
                time.sleep(.05)
            if (scope / 'cgroup.procs').read_text().strip():
                raise RuntimeError('Owned process scope remains populated')
            for directory, _children, _files in os.walk(scope, topdown=False):
                pathlib.Path(directory).rmdir()
            retired = True
        except BaseException as error:
            failure = 'Retirement' + type(error).__name__
    # Freeze cancellation at the terminal publication decision. Signals already
    # delivered or pending make this an interrupted build even if the compiler
    # succeeded; later signals cannot rewrite an immutable terminal receipt.
    mask = signal.pthread_sigmask(signal.SIG_BLOCK, set(prior))
    try:
        if interrupted or signal.sigpending().intersection(prior):
            code = 130
        result = {**identity, 'state': 'finished' if retired else 'retirement_unconfirmed',
                  'code': code, 'retired': retired, 'failure': failure,
                  'passed': code == 0 and retired and failure is None}
        persist(job / 'result.json', result)
        return result
    finally:
        for signum, handler in prior.items():
            signal.signal(signum, handler)
        signal.pthread_sigmask(signal.SIG_SETMASK, mask)


if __name__ == '__main__':
    result = run_build(sys.argv[1])
    sys.exit(0 if result['passed'] else 1)
