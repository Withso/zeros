"""Private, bounded evidence transport. The kit never prints this response."""
import base64
import json
import os
import selectors
import signal
import stat
import subprocess
import time

ARTIFACT = "{{ARTIFACT}}"
ATTEMPT = "{{ATTEMPT}}"
LIMIT = 32768
ENV = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8", "SYSTEMD_COLORS": "0"}


def file_tail(path):
    parts = path.strip('/').split('/')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        child = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        try:
            info = os.fstat(child)
            assert stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1
            os.lseek(child, max(0, info.st_size - LIMIT), os.SEEK_SET)
            data = os.read(child, LIMIT)
            # Do not retain a credential suffix from a cut first log line.
            return data.partition(b'\n')[2] if info.st_size > LIMIT else data
        finally:
            os.close(child)
    finally:
        os.close(fd)


def command_tail(argv):
    child = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                             env=ENV, start_new_session=True)
    tail = b''
    truncated = False
    deadline = time.monotonic() + 8
    try:
        os.set_blocking(child.stdout.fileno(), False)
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ)
            while selector.get_map():
                if time.monotonic() >= deadline:
                    break
                for key, _ in selector.select(0.1):
                    data = os.read(key.fd, 8192)
                    truncated = truncated or len(tail) + len(data) > LIMIT
                    tail = (tail + data)[-LIMIT:]
                    if not data:
                        selector.unregister(key.fileobj)
        return tail.partition(b'\n')[2] if truncated else tail
    finally:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait(timeout=2)
        child.stdout.close()


data, outcome = b'', 'unavailable'
try:
    if ARTIFACT == 'build':
        data = file_tail('/root/zeros-base-v4-builds/' + ATTEMPT + '/build.log')
    elif ARTIFACT == 'bootstrap':
        data = file_tail('/run/zeros/bootstrap-failures.jsonl')
    elif ARTIFACT == 'systemd':
        data = command_tail(['/usr/bin/systemctl', '--no-pager', '--full', '--lines=64', 'status',
                             'zeros-boot.service', 'zeros-host.service'])
    elif ARTIFACT == 'journal':
        data = command_tail(['/usr/bin/journalctl', '--no-pager', '--lines=200',
                             '--unit=zeros-boot.service', '--unit=zeros-host.service'])
    else:
        raise ValueError()
    outcome = 'captured'
except FileNotFoundError:
    outcome = 'absent'
except BaseException:
    pass
print(json.dumps({'schema': 'zeros.base-private-evidence/v1', 'artifact': ARTIFACT,
                  'outcome': outcome, 'data': base64.b64encode(data).decode('ascii')}, separators=(',', ':')), flush=True)
