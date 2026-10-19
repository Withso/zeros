"""Sanitize only an empty, newly built v4 base; never an installed workspace."""
import sys
sys.dont_write_bytecode = True

import contextlib
import ctypes
import importlib.util
import json
import os
import stat
import uuid


def exchange_stock_leaf(source, source_name, destination, destination_name):
    # Atomic exchange preserves an unexpected replacement in private custody.
    # There is deliberately no unlink/rename fallback when unsupported.
    libc = ctypes.CDLL(None, use_errno=True)
    exchange = libc.renameat2
    exchange.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint)
    exchange.restype = ctypes.c_int
    if exchange(source, os.fsencode(source_name), destination, os.fsencode(destination_name), 2) != 0:
        raise OSError(ctypes.get_errno(), 'stock_leaf_exchange')


def normalize_stock_private_state(app, private_home_paths):
    """Only the empty-base builder may replace stock aliases/cache sockets.

    Never follow a link or connect to a socket. Both the original name and its
    displaced private name receive empty regular files, so capture need not
    recognize a deletion. Any identity race retains the displaced object and
    fails the build. Default installed-Computer sanitation remains strict.
    """
    count, replacements = 0, 0

    def identity(info):
        return info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid

    def require(condition):
        if not condition: raise RuntimeError('stock_private_state')

    def normalize(path):
        nonlocal count, replacements
        watches = []

        def validate():
            for parent, name, fd, original in watches:
                require(identity(os.fstat(fd)) == original == identity(os.stat(name, dir_fd=parent, follow_symlinks=False)))

        def open_directory(stack, parent, name):
            before = os.stat(name, dir_fd=parent, follow_symlinks=False)
            require(stat.S_ISDIR(before.st_mode))
            fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
            stack.callback(os.close, fd)
            require(identity(os.fstat(fd)) == identity(before))
            watches.append((parent, name, fd, identity(before)))
            stack.callback(watches.pop)
            return fd

        def replace_leaf(parent, name, before):
            nonlocal replacements
            replacements += 1
            require(replacements <= 256 and before.st_nlink == 1)
            with contextlib.ExitStack() as stack:
                original = os.open(name, os.O_PATH | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
                stack.callback(os.close, original)
                require(identity(os.fstat(original)) == identity(before))
                validate()
                custody_name = '.zeros-base-sanitize-' + uuid.uuid4().hex
                parent_info = os.fstat(parent)
                os.mkdir(custody_name, 0o700, dir_fd=parent)
                custody = open_directory(stack, parent, custody_name)
                created = os.fstat(custody)
                # A provider-owned parent may be writable or setgid. Never
                # adopt a substituted directory by changing its permissions.
                require(created.st_uid == app.uid and stat.S_IMODE(created.st_mode) in (0o700, 0o2700) and
                        created.st_gid == (parent_info.st_gid if parent_info.st_mode & stat.S_ISGID else app.gid) and
                        not os.listdir(custody))
                validate()
                os.fchown(custody, app.uid, app.gid)
                os.fchmod(custody, 0o700)
                watches[-1] = (parent, custody_name, custody, identity(os.fstat(custody)))

                def empty(name):
                    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                                 0o600, dir_fd=custody)
                    stack.callback(os.close, fd)
                    os.fchown(fd, app.uid, app.gid)
                    os.fchmod(fd, 0o600)
                    info = os.fstat(fd)
                    require(stat.S_ISREG(info.st_mode) and info.st_size == 0 and info.st_nlink == 1)
                    os.fsync(fd)
                    return fd

                replacement = empty('entry')
                replacement_identity = identity(os.fstat(replacement))
                validate()
                require(identity(os.stat(name, dir_fd=parent, follow_symlinks=False)) == identity(before) and
                        os.stat(name, dir_fd=parent, follow_symlinks=False).st_nlink == 1)
                exchange_stock_leaf(custody, 'entry', parent, name)
                # An unrecognized displaced inode stays intact in custody.
                # In particular, never truncate or unlink it on this failure.
                validate()
                require(identity(os.fstat(original)) == identity(before) ==
                        identity(os.stat('entry', dir_fd=custody, follow_symlinks=False)) and
                        os.fstat(original).st_nlink == 1 and os.stat('entry', dir_fd=custody, follow_symlinks=False).st_nlink == 1)
                require(identity(os.stat(name, dir_fd=parent, follow_symlinks=False)) == replacement_identity and
                        os.fstat(replacement).st_size == 0 and os.fstat(replacement).st_nlink == 1)
                # Custody is root-only, even beneath a provider-owned parent.
                # Replace the positively identified original without leaving
                # a deletion-only alias for an incremental snapshot to retain.
                retained = empty('empty')
                validate()
                os.replace('empty', 'entry', src_dir_fd=custody, dst_dir_fd=custody)
                require(identity(os.stat('entry', dir_fd=custody, follow_symlinks=False)) == identity(os.fstat(retained)) and
                        os.fstat(retained).st_size == 0 and os.fstat(retained).st_nlink == 1)
                os.fsync(custody)
                os.fsync(parent)
                validate()
                require(identity(os.stat(name, dir_fd=parent, follow_symlinks=False)) == replacement_identity)
                return custody_name

        def visit(parent, name, depth=0):
            nonlocal count
            count += 1
            require(count <= 262144 and depth <= 128)
            before = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if stat.S_ISLNK(before.st_mode) or stat.S_ISSOCK(before.st_mode):
                return replace_leaf(parent, name, before)
            if not stat.S_ISDIR(before.st_mode): return None  # Strict sanitizer checks all other leaf kinds.
            with contextlib.ExitStack() as stack:
                directory = open_directory(stack, parent, name)
                names = sorted(os.listdir(directory))
                require(len(names) <= 262144)
                additions = []
                for child in names:
                    added = visit(directory, child, depth + 1)
                    if added: additions.append(added)
                validate()
                require(sorted(os.listdir(directory)) == sorted(names + additions))
            return None

        with contextlib.ExitStack() as stack:
            parent = open_directory(stack, None, app.root)
            parts = path.strip('/').split('/')
            for name in parts[:-1]:
                try: os.stat(name, dir_fd=parent, follow_symlinks=False)
                except FileNotFoundError: return
                parent = open_directory(stack, parent, name)
            try: os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)
            except FileNotFoundError: return
            visit(parent, parts[-1])
            validate()

    for path in ('/var/log', '/run/log/journal'):
        normalize(path)
    for home in ('/root', '/home/user'):
        for name in private_home_paths:
            normalize(home + '/' + name)
        for target in app.path(home).glob('.env*'):
            normalize('/' + str(target.relative_to(app.root)))


def sanitize():
    assert os.geteuid() == 0 and len(sys.argv) == 1
    spec = importlib.util.spec_from_file_location('bootstrap', '/opt/zeros-bootstrap/bootstrap.py')
    bootstrap = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bootstrap)
    app = bootstrap.Bootstrap()
    try:
        app.base()
        app.wait_ready(empty_base=True)
        with app.lock('runtime-install.lock'), app.lock('runtime-publication.lock'):
            return sanitize_base(app)
    except BaseException as error:
        app.log_failure(error, stage='sanitize')
        raise


def sanitize_base(app):
    assert json.loads(app.read('/etc/zeros/cloud-worker.json', 4096, 0o444))['version'] == 4
    app.require_empty_base()

    # app.base() verified this protected helper before sanitation. Use the
    # same descriptor-bound overwrite policy as installed Computer builds.
    spec = importlib.util.spec_from_file_location('computer_build', app.path('/opt/zeros-bootstrap/computer-build.py'))
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    state = helper.ComputerBuild(app.root, uid=app.uid, gid=app.gid)
    # An interrupted attempt may hold an unrecognized displaced inode. Fence
    # retries before any mutation; only a complete synced sanitation clears it.
    # This builder-only record is outside the roots the sanitizer empties.
    app.atomic('/run/zeros/base-sanitation', b'pending\n')
    normalize_stock_private_state(app, helper.PRIVATE_HOME_PATHS)
    state.empty_private_state()
    # The base has no selected repositories. Keep bind-source identities while
    # clearing their contents; Computer sanitation preserves its selected repos.
    state.clear_directory('/srv/zeros/files/repos')
    for child in app.path('/tmp').glob('zeros-v2-test-base-*'):
        state.empty_path('/' + str(child.relative_to(app.root)))
    state.empty_path('/root/zeros-base-v4-builds')
    os.sync()
    app.atomic('/run/zeros/base-sanitation', b'')
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
