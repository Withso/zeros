"""Base-owned Computer integrity primitives. No command or authority issuer.

Call only after the registry-pinned base has verified this helper. Runtime
content verification and fresh launch custody remain separate requirements.
"""
import contextlib
import ctypes
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import struct

NOTES_LIMIT = 65_536
FEATURE_LIMIT = 4096
PROCFS = 0x9fa0
SYSFS = 0x62656572
SECURITYFS = 0x73636673
CGROUP2 = 0x63677270
INTEGRITY_MAX_BYTES = 8 * 1024 * 1024
INVENTORY_MAX_ENTRIES = 16_384
INVENTORY_MAX_READ_BYTES = 1024 * 1024 * 1024
PROTECTED_FILE_MAX_BYTES = 512 * 1024 * 1024
PROVIDER_ANCESTORS = {"/usr/local", "/usr/local/lib"}
FORBIDDEN_XATTRS = {"security.capability", "system.posix_acl_access", "system.posix_acl_default"}
PRINCIPAL_FILES = {"/etc/passwd", "/etc/group", "/etc/subuid", "/etc/subgid"}
PRINCIPAL_NAMES = {"root", "zeros-agent", "zeros-capture", "zeros-engine", "zeros-coordinator"}
PRINCIPAL_IDS = {0, 10001, 10002, 10003, 10004}
SYSTEMD_SURFACES = tuple("/" + path for path in (
    "etc/systemd/system", "etc/systemd/system.control", "etc/systemd/system.attached",
    "run/systemd/system", "run/systemd/system.control", "run/systemd/system.attached",
    "run/systemd/transient", "run/systemd/generator.early", "run/systemd/generator", "run/systemd/generator.late",
    "usr/lib/systemd/system"))
FIXED_TREES = (
    "/opt/zeros-bootstrap", "/etc/zeros", "/etc/sudoers.d", "/etc/apparmor.d/abi", "/etc/apparmor.d/tunables",
    "/etc/ld.so.conf.d", "/etc/systemd/system.conf.d", "/run/systemd/system.conf.d", "/usr/lib/systemd/system.conf.d",
    "/usr/lib/zeros-runner", "/usr/lib/python3.12", "/usr/lib/python3/dist-packages",
    "/usr/local/lib/python3.12/dist-packages", "/usr/local/lib/python3.12/site-packages",
)
FIXED_FILES = tuple(sorted(PRINCIPAL_FILES | {
    "/etc/sudoers", "/etc/nsswitch.conf", "/etc/ld.so.conf", "/etc/ld.so.cache", "/etc/ld.so.preload",
    "/etc/apparmor/parser.conf", "/etc/apparmor.d/zeros-cloud-engine", "/etc/apparmor.d/local/zeros-cloud-engine",
    "/etc/tmpfiles.d/zeros.conf", "/run/tmpfiles.d/zeros.conf", "/usr/lib/tmpfiles.d/zeros.conf",
    "/etc/systemd/system.conf", "/usr/lib/systemd/system.conf", "/usr/lib/systemd/systemd",
    "/usr/bin/python3", "/usr/bin/ldd", "/usr/sbin/apparmor_parser", "/usr/bin/aa-exec",
    "/lib", "/lib64", "/bin", "/sbin", "/opt/zeros/current", "/opt/zeros/bin", "/opt/zeros/worker",
    "/opt/zeros/manifest.json", "/zeros",
}))


class Failure(Exception):
    def __init__(self): super().__init__("computer_boot_integrity_unavailable")


def require(condition):
    if not condition: raise Failure()


def packed(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def filesystem_type(fd):
    # Linux x86_64 is the only advertised base contract. f_type is the first
    # native long; reserve more than struct statfs without trusting path names.
    result = ctypes.create_string_buffer(256)
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.fstatfs(fd, ctypes.byref(result)) != 0: raise Failure()
    return ctypes.c_long.from_buffer(result).value


def inode(info):
    return info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid


def read_identity(info):
    # Local read witness only. These times are never cross-boot evidence.
    return inode(info) + (info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def provider_pair(value, uid, gid):
    if value is None: return None
    require(type(value) is dict and set(value) == {"uid", "gid"})
    for key, owner in (("uid", uid), ("gid", gid)):
        require(type(value[key]) is int and 0 < value[key] < 2**31 and
                value[key] not in {owner, 10001, 10002, 10003, 10004})
    return dict(value)


class KernelReader:
    """Bounded pseudo-file reads with no-follow ancestry and original FDs.

    Explicit constructor arguments support disposable offline fixtures only;
    no environment or request field selects the root, owner or filesystem.
    """
    def __init__(self, root=Path("/"), *, uid=0, gid=0, filesystem_type=filesystem_type):
        self.root, self.uid, self.gid = Path(root), uid, gid
        self.filesystem_type = filesystem_type

    def valid(self, info, directory):
        require((stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode) and info.st_nlink == 1)
                and info.st_uid == self.uid and info.st_gid == self.gid and not info.st_mode & 0o022)

    def read(self, name, maximum, filesystem):
        try:
            require(type(name) is str and re.fullmatch(r"/(?:[A-Za-z0-9_.-]+/)*[A-Za-z0-9_.-]+", name)
                    and all(part not in (".", "..") for part in name.split("/"))
                    and type(maximum) is int and 0 < maximum <= NOTES_LIMIT)
            with contextlib.ExitStack() as stack:
                parent = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
                stack.callback(os.close, parent)
                root_info = os.fstat(parent)
                self.valid(root_info, True)
                root_fd, watches = parent, []
                parts = name.lstrip("/").split("/")
                for index, part in enumerate(parts):
                    directory = index < len(parts) - 1
                    before = os.stat(part, dir_fd=parent, follow_symlinks=False)
                    self.valid(before, directory)
                    fd = os.open(part, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC |
                                 (os.O_DIRECTORY if directory else 0), dir_fd=parent)
                    stack.callback(os.close, fd)
                    require(inode(os.fstat(fd)) == inode(before))
                    watches.append((parent, part, fd, inode(before)))
                    parent = fd
                require(self.filesystem_type(fd) == filesystem)
                before = os.fstat(fd)
                chunks, size = [], 0
                while size <= maximum:
                    block = os.read(fd, min(8192, maximum + 1 - size))
                    if not block: break
                    chunks.append(block)
                    size += len(block)
                require(0 < size <= maximum)
                after = os.fstat(fd)
                # Pseudo-file size may be zero even when readable. Size is not
                # a substitute for the bound on bytes actually consumed.
                require((before.st_size, before.st_mtime_ns, before.st_ctime_ns) ==
                        (after.st_size, after.st_mtime_ns, after.st_ctime_ns))
                require(inode(os.fstat(root_fd)) == inode(root_info) == inode(os.lstat(self.root)))
                for directory, part, descriptor, original in watches:
                    require(inode(os.fstat(descriptor)) == original ==
                            inode(os.stat(part, dir_fd=directory, follow_symlinks=False)))
                return b"".join(chunks)
        except (OSError, ValueError, OverflowError):
            raise Failure() from None


def gnu_build_id(notes):
    require(type(notes) is bytes and 0 < len(notes) <= NOTES_LIMIT)
    result, offset, count = None, 0, 0
    while offset < len(notes):
        require(len(notes) - offset >= 12 and count < 1024)
        name_size, value_size, kind = struct.unpack_from("<III", notes, offset)
        offset += 12
        name_end = offset + name_size
        value_start = (name_end + 3) & ~3
        value_end = value_start + value_size
        end = (value_end + 3) & ~3
        require(name_size > 0 and name_end <= value_start <= value_end <= end <= len(notes))
        if notes[offset:name_end] == b"GNU\0" and kind == 3:
            require(result is None and 1 <= value_size <= 128)
            result = notes[value_start:value_end].hex()
        offset, count = end, count + 1
    require(result is not None)
    return result


def running_kernel_identity(*, read=None, uname=os.uname):
    """Fingerprint the live trusted-provider kernel, not a disk /boot image.

    This is neither TPM attestation nor authority to launch. Keep the actual
    current boot UUID separate, and require complete full-qualification results.
    """
    try:
        read = read or KernelReader().read
        original = uname()
        require(original.machine == "x86_64")
        for value in (original.release, original.version):
            require(type(value) is str and re.fullmatch(r"[\x20-\x7e]{1,256}", value))

        def line(name, filesystem, maximum=1024):
            raw = read(name, maximum, filesystem)
            require(type(raw) is bytes and 0 < len(raw) <= maximum)
            text = raw.decode("ascii").removesuffix("\n")
            require(re.fullmatch(r"[\x20-\x7e]+", text))
            return text

        notes = read("/sys/kernel/notes", NOTES_LIMIT, SYSFS)
        build_id = gnu_build_id(notes)
        require(line("/proc/sys/kernel/osrelease", PROCFS, 257) == original.release and
                line("/proc/sys/kernel/version", PROCFS, 257) == original.version)

        def names(value, separator):
            values = value.split(separator)
            require(0 < len(values) <= 64 and len(set(values)) == len(values) and
                    all(re.fullmatch(r"[a-z][a-z0-9_]{0,31}", item) for item in values))
            return sorted(values)

        lsm = names(line("/sys/kernel/security/lsm", SECURITYFS), ",")
        require("apparmor" in lsm and line("/sys/module/apparmor/parameters/enabled", SYSFS, 8) == "Y")
        require(line("/proc/sys/kernel/unprivileged_userns_clone", PROCFS, 8) == "1")
        maximum_namespaces = line("/proc/sys/user/max_user_namespaces", PROCFS, 16)
        require(re.fullmatch(r"[1-9][0-9]{0,9}", maximum_namespaces) and int(maximum_namespaces) <= 2_147_483_647)
        actions = names(line("/proc/sys/kernel/seccomp/actions_avail", PROCFS), " ")
        require({"kill_process", "kill_thread", "trap", "errno", "trace", "log", "allow"} <= set(actions))
        controllers = names(line("/sys/fs/cgroup/cgroup.controllers", CGROUP2), " ")
        require({"cpu", "memory", "pids"} <= set(controllers))
        features = {"schema": "zeros.kernel-feature-policy/v1", "lsm": lsm, "apparmorEnabled": True,
                    "unprivilegedUsernsClone": True, "maxUserNamespaces": int(maximum_namespaces),
                    "seccompActions": actions, "cgroupControllers": controllers}
        require(len(packed(features)) <= FEATURE_LIMIT)
        current = uname()
        require((current.machine, current.release, current.version) == (original.machine, original.release, original.version))
        return {"kernel": {"architecture": "x86_64", "release": original.release, "version": original.version,
                           "buildId": build_id, "notesSha256": hashlib.sha256(notes).hexdigest(),
                           "features": {"cgroupV2": True, "userNamespaces": True, "seccompFilter": True, "apparmor": True}},
                "features": features}
    except (OSError, ValueError, KeyError, UnicodeError, struct.error, TypeError):
        raise Failure() from None


def inventory_path(value):
    require(type(value) is str and len(value) <= 4096 and
            re.fullmatch(r"/(?:[A-Za-z0-9_.@+-]+/)*[A-Za-z0-9_.@+-]+", value) and
            all(part not in (".", "..") for part in value.split("/")))
    return value


def principal_digest(name, raw):
    require(name in PRINCIPAL_FILES and len(raw) <= 1024 * 1024)
    rows = []
    database = name.rsplit("/", 1)[1]
    for line in raw.decode("utf8").splitlines():
        if not line: continue
        fields = line.split(":")
        require(len(fields) == {"passwd": 7, "group": 4, "subuid": 3, "subgid": 3}[database])
        protected = fields[0] in PRINCIPAL_NAMES or fields[0] in {str(value) for value in PRINCIPAL_IDS}
        if database in ("passwd", "group"):
            require(re.fullmatch(r"[0-9]{1,10}", fields[2]))
            protected = protected or int(fields[2]) in PRINCIPAL_IDS
            if database == "passwd":
                require(re.fullmatch(r"[0-9]{1,10}", fields[3]))
                protected = protected or int(fields[3]) in PRINCIPAL_IDS
        else:
            require(all(re.fullmatch(r"[0-9]{1,10}", value) for value in fields[1:]))
            first, count = map(int, fields[1:])
            require(count > 0 and first + count <= 2**32)
            protected = protected or any(first <= value < first + count for value in PRINCIPAL_IDS)
        if protected: rows.append(line)
    # Do not serialize account fields, including a possible password field.
    # Only the relevant policy's digest crosses this boundary.
    return hashlib.sha256(packed(sorted(rows))).hexdigest()


class IntegrityInventory:
    """Exact protected bytes and policy metadata, never a boot authority.

    Build callers derive selectors from the fixed protected closure. Boot
    callers consume only an externally pinned manifest, never a fresh ldd
    inventory or locally chosen digest. Ordinary user data is not selected.
    """
    def __init__(self, root=Path("/"), *, uid=0, gid=0, provider=None, check_budget=None):
        self.root, self.uid, self.gid = Path(root), uid, gid
        self.provider = provider_pair(provider, uid, gid)
        self.entries, self.witnesses = {}, {}
        self.read_bytes = 0
        self.check_budget = check_budget

    def _budget(self):
        if self.check_budget is not None: self.check_budget()

    def _put(self, name, value):
        prior = self.entries.get(name)
        if prior is not None:
            require({key: item for key, item in prior.items() if key != "children"} ==
                    {key: item for key, item in value.items() if key != "children"})
            if "children" in prior:
                require("children" not in value or value["children"] == prior["children"])
                value = prior
        self.entries[name] = value
        require(len(self.entries) <= INVENTORY_MAX_ENTRIES)

    def _witness(self, name, info):
        value = None if info is None else inode(info)
        if info is not None and stat.S_ISREG(info.st_mode):
            value += (info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
        if name in self.witnesses: require(self.witnesses[name] == value)
        self.witnesses[name] = value

    def _metadata(self, fd, info, name):
        allowed = {(self.uid, self.gid)}
        if name in PROVIDER_ANCESTORS:
            require(stat.S_ISDIR(info.st_mode))
            if self.provider is not None: allowed.add((self.provider["uid"], self.provider["gid"]))
        require((info.st_uid, info.st_gid) in allowed)
        if stat.S_ISLNK(info.st_mode):
            return {"kind": "link", "mode": stat.S_IMODE(info.st_mode), "uid": info.st_uid, "gid": info.st_gid}
        require(not info.st_mode & 0o022 and not FORBIDDEN_XATTRS.intersection(os.listxattr(fd)))
        require(stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode) and info.st_nlink == 1)
        return {"kind": "directory" if stat.S_ISDIR(info.st_mode) else "file",
                "mode": stat.S_IMODE(info.st_mode), "uid": info.st_uid, "gid": info.st_gid, "xattrs": []}

    def _read(self, name, recursive):
        self._budget()
        inventory_path(name)
        with contextlib.ExitStack() as stack:
            root = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
            stack.callback(os.close, root)
            info = os.fstat(root)
            require(stat.S_ISDIR(info.st_mode))
            self._put("/", self._metadata(root, info, "/"))
            self._witness("/", info)
            watches, missing, directories, current = [], None, [root], []
            pending, links = name.lstrip("/").split("/"), 0
            selected, children = None, []
            while pending:
                self._budget()
                part = pending.pop(0)
                if part in ("", "."): continue
                if part == "..":
                    require(len(directories) > 1)
                    directories.pop()
                    current.pop()
                    continue
                require(re.fullmatch(r"[A-Za-z0-9_.@+-]+", part) and len(current) < 128)
                path = "/" + "/".join([*current, part])
                parent = directories[-1]
                try:
                    before = os.stat(part, dir_fd=parent, follow_symlinks=False)
                except FileNotFoundError:
                    self._put(path, {"kind": "absent"})
                    self._witness(path, None)
                    missing, selected = (parent, part), path
                    break
                symbolic = stat.S_ISLNK(before.st_mode)
                require(symbolic or stat.S_ISREG(before.st_mode) or stat.S_ISDIR(before.st_mode))
                flags = os.O_PATH if symbolic else os.O_RDONLY | os.O_NONBLOCK | (os.O_DIRECTORY if stat.S_ISDIR(before.st_mode) else 0)
                fd = os.open(part, flags | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
                stack.callback(os.close, fd)
                observed = os.fstat(fd)
                require(read_identity(observed) == read_identity(before))
                record = self._metadata(fd, observed, path)
                self._witness(path, observed)
                watches.append((parent, part, fd, path, read_identity(observed)))
                if symbolic:
                    links += 1
                    require(links <= 32)
                    target = os.readlink("", dir_fd=fd)
                    require(0 < len(target) <= 4096 and "\0" not in target)
                    record["target"] = target
                    self._put(path, record)
                    if target.startswith("/"):
                        current, directories = [], [root]
                    pending = target.split("/") + pending
                    continue
                if stat.S_ISDIR(observed.st_mode):
                    directories.append(fd)
                    current.append(part)
                    if not pending:
                        if recursive:
                            children = sorted(os.listdir(fd))
                            require(len(children) <= INVENTORY_MAX_ENTRIES)
                            record["children"] = children
                        selected = path
                else:
                    require(not pending and observed.st_size <= PROTECTED_FILE_MAX_BYTES)
                    digest, size, principal_chunks = hashlib.sha256(), 0, []
                    while size <= PROTECTED_FILE_MAX_BYTES:
                        self._budget()
                        block = os.read(fd, min(1024 * 1024, PROTECTED_FILE_MAX_BYTES + 1 - size,
                                                INVENTORY_MAX_READ_BYTES + 1 - self.read_bytes))
                        if not block: break
                        size += len(block)
                        self.read_bytes += len(block)
                        require(self.read_bytes <= INVENTORY_MAX_READ_BYTES)
                        digest.update(block)
                        if path in PRINCIPAL_FILES:
                            require(size <= 1024 * 1024)
                            principal_chunks.append(block)
                    require(size == observed.st_size and size <= PROTECTED_FILE_MAX_BYTES)
                    after = os.fstat(fd)
                    require((observed.st_size, observed.st_mtime_ns, observed.st_ctime_ns, observed.st_nlink) ==
                            (after.st_size, after.st_mtime_ns, after.st_ctime_ns, after.st_nlink))
                    if path in PRINCIPAL_FILES:
                        record.update({"kind": "principals", "sha256": principal_digest(path, b"".join(principal_chunks))})
                    else:
                        record.update({"sha256": digest.hexdigest(), "size": size})
                    selected = path
                self._put(path, record)
            require(selected is not None)
            self._metadata(root, os.fstat(root), "/")
            require(read_identity(os.fstat(root)) == read_identity(info) == read_identity(os.lstat(self.root)))
            for parent, part, fd, path, original in watches:
                self._metadata(fd, os.fstat(fd), path)
                require(read_identity(os.fstat(fd)) == original == read_identity(os.stat(part, dir_fd=parent, follow_symlinks=False)))
            if missing:
                try: os.stat(missing[1], dir_fd=missing[0], follow_symlinks=False)
                except FileNotFoundError: pass
                else: raise Failure()
            if recursive and self.entries[selected]["kind"] == "directory":
                require(sorted(os.listdir(directories[-1])) == children)
            self._budget()
            return selected, children

    def capture(self, selectors):
        try:
            require(not self.entries and type(selectors) is list and 0 < len(selectors) <= INVENTORY_MAX_ENTRIES)
            for item in selectors:
                require(type(item) is dict and set(item) == {"path", "recursive"} and type(item["recursive"]) is bool)
                inventory_path(item["path"])
            require(len({item["path"] for item in selectors}) == len(selectors))
            selectors = sorted(selectors, key=lambda item: item["path"])
            pending = [(item["path"], item["recursive"]) for item in selectors]
            trees = set()
            while pending:
                name, recursive = pending.pop()
                selected, children = self._read(name, recursive)
                if recursive and selected not in trees:
                    trees.add(selected)
                    pending.extend((selected + "/" + child, True) for child in children)
            # Detect replacement/change across later hashing as well as within
            # each read. Inodes are local witnesses, never serialized across a
            # restore; only the stable bytes and policy metadata enter evidence.
            for name in list(self.entries):
                if name != "/": self._read(name, "children" in self.entries[name])
            result = {"schema": "zeros.computer-boot-integrity-inventory/v1", "provider": self.provider, "selectors": selectors,
                      "entries": dict(sorted(self.entries.items()))}
            require(len(packed(result)) <= INTEGRITY_MAX_BYTES)
            self._budget()
            return result
        except (OSError, ValueError, TypeError, KeyError, OverflowError):
            raise Failure() from None


def verify_integrity_inventory(value, expected_sha256, *, root=Path("/"), uid=0, gid=0, check_budget=None):
    try:
        require(type(value) is dict and set(value) == {"schema", "provider", "selectors", "entries"} and
                value["schema"] == "zeros.computer-boot-integrity-inventory/v1" and
                type(expected_sha256) is str and re.fullmatch(r"[a-f0-9]{64}", expected_sha256))
        encoded = packed(value)
        require(len(encoded) <= INTEGRITY_MAX_BYTES and hashlib.sha256(encoded).hexdigest() == expected_sha256)
        observed = IntegrityInventory(root, uid=uid, gid=gid, provider=value["provider"], check_budget=check_budget).capture(value["selectors"])
        require(packed(observed) == encoded)
    except (OSError, ValueError, TypeError, KeyError, OverflowError):
        raise Failure() from None


def systemd_paths(*, root=Path("/"), uid=0, gid=0, build_id=None):
    """Discover only protected unit/override names, with original directory FDs.

    Unrelated package units may be added. Every priority surface is inspected,
    including generators and control overrides. The sole excluded transient
    belongs to this exact build; that exclusion is never part of a boot proof.
    The provider-owned optional /usr/local surface uses bootstrap's separate
    qualified-absence policy, not a relaxed ownership rule here.
    """
    try:
        require(build_id is None or type(build_id) is str and
                re.fullmatch(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}", build_id))
        excluded = "/run/systemd/transient/zeros-computer-install-" + (build_id or "") + ".service"
        result, count = set(), 0
        with contextlib.ExitStack() as stack:
            fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
            stack.callback(os.close, fd)
            watches, missing = [], []

            def checked(descriptor):
                info = os.fstat(descriptor)
                require(stat.S_ISDIR(info.st_mode) and (info.st_uid, info.st_gid) == (uid, gid) and
                        not info.st_mode & 0o7022 and not FORBIDDEN_XATTRS.intersection(os.listxattr(descriptor)))
                return inode(info) + (info.st_mtime_ns, info.st_ctime_ns)

            root_identity = checked(fd)

            def opened(parent, name):
                before = os.stat(name, dir_fd=parent, follow_symlinks=False)
                require(stat.S_ISDIR(before.st_mode))
                try:
                    child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
                except FileNotFoundError:
                    # Only the initial stat may establish absence. A directory
                    # that disappeared after observation invalidates this read.
                    raise Failure() from None
                stack.callback(os.close, child)
                identity = checked(child)
                require(identity == inode(before) + (before.st_mtime_ns, before.st_ctime_ns))
                watches.append((parent, name, child, identity))
                require(len(watches) <= 4096)
                return child

            for surface in SYSTEMD_SURFACES:
                parent = fd
                for part in surface.lstrip("/").split("/"):
                    try: parent = opened(parent, part)
                    except FileNotFoundError:
                        missing.append((parent, part))
                        break
                else:
                    pending = [(parent, surface, 0)]
                    while pending:
                        directory, prefix, depth = pending.pop()
                        names = os.listdir(directory)
                        count += len(names)
                        require(count <= 8192 and depth <= 16)
                        for name in names:
                            path = prefix + "/" + name
                            if path == excluded: continue
                            if name.startswith("zeros-") or name in ("service.d", "target.d"):
                                result.add(inventory_path(path))
                            else:
                                info = os.stat(name, dir_fd=directory, follow_symlinks=False)
                                if stat.S_ISDIR(info.st_mode):
                                    pending.append((opened(directory, name), path, depth + 1))
                                elif name.endswith((".wants", ".requires", ".upholds")):
                                    # Do not let a link hide a second unit tree.
                                    raise Failure()
            require(checked(fd) == root_identity and inode(os.lstat(root)) == root_identity[:5])
            for parent, name, child, original in watches:
                current = os.stat(name, dir_fd=parent, follow_symlinks=False)
                require(checked(child) == original == inode(current) + (current.st_mtime_ns, current.st_ctime_ns))
            for parent, name in missing:
                try: os.stat(name, dir_fd=parent, follow_symlinks=False)
                except FileNotFoundError: pass
                else: raise Failure()
        return sorted(result)
    except (OSError, ValueError, TypeError, KeyError, OverflowError):
        raise Failure() from None


def dependency_path(value):
    inventory_path(value)
    require(re.fullmatch(r"/(?:usr/)?(?:bin|sbin|lib|lib64|libexec)/.+", value))
    return value


def elf_has_loader(raw):
    """None for a script, false only for a structurally static x86_64 ELF."""
    require(type(raw) is bytes and len(raw) <= NOTES_LIMIT)
    if not raw.startswith(b"\x7fELF"): return None
    require(len(raw) >= 64 and raw[:6] == b"\x7fELF\x02\x01" and struct.unpack_from("<H", raw, 18)[0] == 62)
    offset, size, count = struct.unpack_from("<Q", raw, 32)[0], struct.unpack_from("<H", raw, 54)[0], struct.unpack_from("<H", raw, 56)[0]
    require(64 <= offset <= NOTES_LIMIT and 56 <= size <= 256 and 1 <= count <= 128 and offset + size * count <= len(raw))
    return any(struct.unpack_from("<I", raw, offset + index * size)[0] in (2, 3) for index in range(count))


def parse_loader_dependencies(raw):
    require(type(raw) is bytes and 0 < len(raw) <= 65_536)
    try:
        result = set()
        for line in raw.decode("ascii").splitlines():
            line = line.strip()
            if re.fullmatch(r"linux-vdso\.so\.[0-9]+ \(0x[a-f0-9]+\)", line): continue
            match = re.fullmatch(r"(?:[A-Za-z0-9_.+-]+ => )?(/[^\s()]+) \(0x[a-f0-9]+\)", line)
            require(match is not None)
            result.add(inventory_path(match[1]))
        require(0 < len(result) <= 1024)
        return sorted(result)
    except (UnicodeError, ValueError):
        raise Failure() from None


def elf_prefix(name, *, root=Path("/"), uid=0, gid=0, provider=None):
    # Paths here are physical inventory files, never aliases. Keep each parent
    # and the opened file pinned through the read. Full bytes are checked by
    # the original inventory again after discovery.
    inventory_path(name)
    try:
        metadata = IntegrityInventory(root, uid=uid, gid=gid, provider=provider)._metadata
        with contextlib.ExitStack() as stack:
            parent = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
            stack.callback(os.close, parent)
            root_fd, watches = parent, []
            root_info = os.fstat(parent)
            require(stat.S_ISDIR(root_info.st_mode) and not root_info.st_mode & 0o7022)
            metadata(parent, root_info, "/")
            parts = name.lstrip("/").split("/")
            for index, part in enumerate(parts):
                directory = index < len(parts) - 1
                fd = os.open(part, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC |
                             (os.O_DIRECTORY if directory else 0), dir_fd=parent)
                stack.callback(os.close, fd)
                info = os.fstat(fd)
                require(stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode) and info.st_nlink == 1)
                path = "/" + "/".join(parts[:index + 1])
                metadata(fd, info, path)
                watches.append((parent, part, fd, path, read_identity(info)))
                parent = fd
            before = os.fstat(fd)
            raw = os.read(fd, NOTES_LIMIT)
            after = os.fstat(fd)
            require((before.st_size, before.st_mtime_ns, before.st_ctime_ns) ==
                    (after.st_size, after.st_mtime_ns, after.st_ctime_ns))
            metadata(root_fd, os.fstat(root_fd), "/")
            require(read_identity(root_info) == read_identity(os.fstat(root_fd)) == read_identity(os.lstat(root)))
            for directory, part, descriptor, path, original in watches:
                metadata(descriptor, os.fstat(descriptor), path)
                require(read_identity(os.fstat(descriptor)) == original == read_identity(os.stat(part, dir_fd=directory, follow_symlinks=False)))
            return raw
    except (OSError, ValueError, TypeError, OverflowError):
        raise Failure() from None


def discover_loader_dependencies(closure, runtime_id, manifest, command, *, root=Path("/"), uid=0, gid=0, check_budget=None):
    """Only the full build uses ldd, after original stock/runtime byte checks.

    Future boot verification consumes the recorded file list. Runtime files
    stay in their full existing manifest; only external resolved dependencies
    join the stable closure. Unknown output or a missing library is a refusal.
    """
    try:
        require(type(runtime_id) is str and re.fullmatch(r"r1-[a-f0-9]{64}", runtime_id))
        runtime_root = "/opt/zeros-infra/" + runtime_id
        candidates = {name for name, entry in closure["inventory"]["entries"].items() if entry["kind"] == "file"}
        for entry in manifest["files"]:
            if entry["type"] == "file" and (int(entry["mode"], 8) & 0o111 or re.search(r"\.(?:so(?:\.[0-9]+)*|node)$", entry["path"])):
                candidates.add(inventory_path(runtime_root + "/" + entry["path"]))
        dependencies, calls = set(), 0
        for name in sorted(candidates):
            if check_budget is not None: check_budget()
            dynamic = elf_has_loader(elf_prefix(name, root=root, uid=uid, gid=gid, provider=closure["inventory"].get("provider")))
            if check_budget is not None: check_budget()
            if not dynamic: continue
            calls += 1
            require(calls <= 512)
            code, output = command([str(Path(root) / "usr/bin/ldd"), str(Path(root) / name.lstrip("/"))], timeout=10, limit=65_536)
            if check_budget is not None: check_budget()
            require(code == 0)
            for dependency in parse_loader_dependencies(output):
                if dependency.startswith(runtime_root + "/"): continue
                dependencies.add(dependency_path(dependency))
            require(len(dependencies) <= 1024)
        return sorted(dependencies)
    except (OSError, ValueError, TypeError, KeyError, OverflowError, struct.error):
        raise Failure() from None


def capture_protected_closure(compatibility, stock, dependencies, *, root=Path("/"), uid=0, gid=0, build_id=None, check_budget=None):
    """Build-only fixed policy. Dependencies come from the verified build.

    Neither a request nor a checkout supplies selectors. Future boots rehash
    this exact inventory; they do not run ldd to discover new expected files.
    The separately pinned full runtime inventory is deliberately not copied.
    """
    try:
        require(type(dependencies) is list and len(dependencies) <= 1024 and
                stock["schema"] == "zeros.stock-prerequisites/v1")
        selected = {path: True for path in FIXED_TREES}
        selected.update({path: False for path in FIXED_FILES})
        for entry in compatibility["protectedFiles"]:
            name = inventory_path(entry["path"])
            require(name.startswith(("/opt/zeros-bootstrap/", "/etc/", "/usr/lib/zeros-runner/")))
            selected.setdefault(name, False)
        for collection in ("binaries", "libraries"):
            require(type(stock[collection]) is dict and 0 < len(stock[collection]) <= 256)
            for name, record in stock[collection].items():
                selected[dependency_path(record["path"])] = False
                alias = name if collection == "binaries" else "/usr/lib/x86_64-linux-gnu/" + name
                selected[dependency_path(alias)] = False
        selected.update({dependency_path(path): False for path in dependencies})
        paths = systemd_paths(root=root, uid=uid, gid=gid, build_id=build_id)
        selected.update({path: True for path in paths})
        # The registered base has already verified this sealed stock policy.
        # Only these exact directory edges may use its provider pair; every
        # selected package/file and deeper directory remains root-owned.
        provider = stock.get("optionalSystemd", {}).get("provider")
        inventory = IntegrityInventory(root, uid=uid, gid=gid, provider=provider, check_budget=check_budget).capture([
            {"path": path, "recursive": recursive} for path, recursive in selected.items()])
        require(systemd_paths(root=root, uid=uid, gid=gid, build_id=build_id) == paths)
        for collection in ("binaries", "libraries"):
            for record in stock[collection].values():
                require(inventory["entries"].get(record["path"], {}).get("sha256") == record["sha256"])
        result = {"schema": "zeros.computer-protected-closure/v1", "policyVersion": 1,
                  "systemdPaths": paths, "inventory": inventory}
        require(len(packed(result)) <= INTEGRITY_MAX_BYTES)
        if check_budget is not None: check_budget()
        return result
    except (OSError, ValueError, TypeError, KeyError, OverflowError):
        raise Failure() from None


def verify_protected_closure(value, *, root=Path("/"), uid=0, gid=0, build_id=None, check_budget=None):
    try:
        require(type(value) is dict and set(value) == {"schema", "policyVersion", "systemdPaths", "inventory"} and
                value["schema"] == "zeros.computer-protected-closure/v1" and type(value["policyVersion"]) is int and
                value["policyVersion"] == 1 and len(packed(value)) <= INTEGRITY_MAX_BYTES)
        require(systemd_paths(root=root, uid=uid, gid=gid, build_id=build_id) == value["systemdPaths"])
        verify_integrity_inventory(value["inventory"], hashlib.sha256(packed(value["inventory"])).hexdigest(),
                                   root=root, uid=uid, gid=gid, check_budget=check_budget)
        require(systemd_paths(root=root, uid=uid, gid=gid, build_id=build_id) == value["systemdPaths"])
        if check_budget is not None: check_budget()
    except (OSError, ValueError, TypeError, KeyError, OverflowError):
        raise Failure() from None
