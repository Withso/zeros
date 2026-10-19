"""Dormant complete-cut primitives. No installer, enrollment or default support.

Raw staging is private intermediate data, not an archive, ACK or final seal.
Only the outside qualified custodian may call it with every source frozen.
The native semantic exporter must handle managed state before private upload.
"""
import base64
import errno
import hashlib
import json
import os
import posixpath
import re
import stat
import struct

MAX_ITEM = 512 * 1024
MAX_READ = 1024 * 1024
ROOT_NAME = re.compile(r"^[a-z][a-z0-9-]{0,31}$")
DATA_NAME = re.compile(r"^[0-9]{12}\.data$")
DIGEST = re.compile(r"^[a-f0-9]{64}$")
META_KEYS = {"mode", "uid", "gid", "atimeNs", "mtimeNs", "xattrs"}


class CutRefused(Exception):
    def __init__(self, reason="coverage_unknown"):
        self.reason = reason if reason in ("coverage_unknown", "deadline", "cancelled", "custody_unknown", "unsupported") else "coverage_unknown"
        super().__init__(self.reason)


def require(value, reason="coverage_unknown"):
    if not value:
        raise CutRefused(reason)


def packed(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("ascii")


def closed_json(value):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result)
            result[key] = value
        return result
    return json.loads(value, object_pairs_hook=pairs)


def integer(value, minimum=0, maximum=2 ** 53 - 1):
    return type(value) is int and minimum <= value <= maximum


def identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
            info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def mount_id(fd):
    with open(f"/proc/self/fdinfo/{fd}", "rb") as source:
        value = source.read(16385)
    require(len(value) <= 16384)
    ids = re.findall(rb"(?m)^mnt_id:\s*([0-9]+)$", value)
    require(len(ids) == 1)
    return int(ids[0])


def write_all(fd, value, guard):
    offset = 0
    while offset < len(value):
        guard()
        written = os.write(fd, value[offset:])
        require(written > 0)
        offset += written
    guard()


def private_file(directory, name, create=False):
    require(name in ("manifest.json", "inventory.jsonl", ".manifest.pending") or DATA_NAME.fullmatch(name))
    flags = os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK
    flags |= os.O_WRONLY | os.O_CREAT | os.O_EXCL if create else os.O_RDONLY
    fd = os.open(name, flags, 0o600, dir_fd=directory)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == os.geteuid()
                and stat.S_IMODE(info.st_mode) == 0o600)
        require(identity(info) == identity(os.stat(name, dir_fd=directory, follow_symlinks=False)))
        return fd
    except BaseException:
        os.close(fd)
        raise


def source_open(directory, name, is_directory=False):
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK | os.O_NOATIME
    if is_directory:
        flags |= os.O_DIRECTORY
    return os.open(name, flags, dir_fd=directory)


def xattrs(fd, limit, uids, gids):
    result = {}
    total = 0
    for name in sorted(os.listxattr(fd)):
        require(name.startswith("user.") or name in ("system.posix_acl_access", "system.posix_acl_default"))
        value = os.getxattr(fd, name)
        total += len(name.encode("utf8")) + len(value)
        require(total <= limit)
        if name.startswith("system.posix_acl_"):
            require(len(value) >= 4 and (len(value) - 4) % 8 == 0 and struct.unpack_from("<I", value)[0] == 2)
            for offset in range(4, len(value), 8):
                tag, permissions, owner = struct.unpack_from("<HHI", value, offset)
                require(permissions <= 7 and tag in (1, 2, 4, 8, 16, 32))
                require(owner in uids if tag == 2 else owner in gids if tag == 8 else owner == 0xffffffff)
        result[name] = base64.b64encode(value).decode("ascii")
    return result


def metadata(info, fd, max_bytes, uids, gids):
    require(info.st_uid in uids and info.st_gid in gids and not info.st_mode & 0o6000)
    return {"mode": stat.S_IMODE(info.st_mode), "uid": info.st_uid, "gid": info.st_gid,
            "atimeNs": info.st_atime_ns, "mtimeNs": info.st_mtime_ns,
            "xattrs": xattrs(fd, max_bytes, uids, gids) if fd is not None else {}}


def valid_path(value, root=False):
    require(type(value) is str and len(value.encode("utf8")) <= 4096)
    require(value == "" and root or value != "" and not value.startswith("/")
            and all(part not in ("", ".", "..") for part in value.split("/")) and "\0" not in value)
    return value


def limits(raw):
    require(type(raw) is dict and set(raw) == {"maxEntries", "maxBytes", "readBytes", "maxMetadataBytes"})
    require(integer(raw["maxEntries"], 1, 1_000_000) and integer(raw["maxBytes"], 1)
            and integer(raw["readBytes"], 4096, MAX_READ) and integer(raw["maxMetadataBytes"], 1, MAX_ITEM // 2))
    return dict(raw)


def stage_raw_cut(roots, destination, bounds, guard, uids, gids):
    """Copy all supplied physical roots once. Caller owns kernel quiescence.

    Source reads are descriptor-relative, no-follow and no-atime. This function
    does not infer quiescence from unchanged metadata. Bounds are attempt work
    limits: refusal never publishes a truncated manifest or deletes a prior cut.
    """
    inventory_fd = None
    manifest_published = False
    try:
        bounds = limits(bounds)
        require(type(roots) is dict and 1 <= len(roots) <= 16 and all(ROOT_NAME.fullmatch(name) for name in roots))
        guard()
        output = os.fstat(destination)
        require(stat.S_ISDIR(output.st_mode) and output.st_uid == os.geteuid() and stat.S_IMODE(output.st_mode) == 0o700)
        require(not os.listdir(destination))
        original_roots = {name: os.fstat(fd) for name, fd in roots.items()}
        require(len({(info.st_dev, info.st_ino) for info in original_roots.values()}) == len(roots))
        inventory_fd = private_file(destination, "inventory.jsonl", True)
        inventory_hash = hashlib.sha256()
        entries = {}
        hardlinks = {}
        total_bytes = 0
        sequence = 0
        inventory_bytes = 0

        def append(entry):
            nonlocal inventory_bytes
            key = (entry["root"], entry["path"])
            require(key not in entries and len(entries) < bounds["maxEntries"])
            value = packed(entry) + b"\n"
            require(len(value) <= MAX_ITEM)
            write_all(inventory_fd, value, guard)
            inventory_hash.update(value)
            inventory_bytes += len(value)
            # Retain only link resolution data, not every metadata/document.
            entries[key] = {key: entry[key] for key in ("kind", "target") if key in entry}

        def zeros(digest, count):
            value = b"\0" * bounds["readBytes"]
            while count:
                guard()
                size = min(count, len(value))
                digest.update(value[:size])
                count -= size

        def regular(root, parent, name, relative, before, source_mount):
            nonlocal total_bytes, sequence
            fd = source_open(parent, name)
            try:
                require(mount_id(fd) == source_mount and identity(before) == identity(os.fstat(fd)))
                entry = {"root": root, "path": relative, **metadata(before, fd, bounds["maxMetadataBytes"], uids, gids)}
                key = (before.st_dev, before.st_ino)
                if key in hardlinks:
                    item = hardlinks[key]
                    require(identity(before) == item["identity"])
                    item["count"] += 1
                    entry.update(kind="hardlink", target=item["target"])
                else:
                    total_bytes += before.st_size
                    require(total_bytes <= bounds["maxBytes"])
                    sequence += 1
                    data_name = f"{sequence:012d}.data"
                    data_fd = private_file(destination, data_name, True)
                    try:
                        content = hashlib.sha256()
                        encoded = hashlib.sha256()
                        offset = stored = 0
                        extents = []
                        while offset < before.st_size:
                            guard()
                            try:
                                start = os.lseek(fd, offset, os.SEEK_DATA)
                            except OSError as error:
                                if error.errno != errno.ENXIO:
                                    raise
                                start = before.st_size
                            require(offset <= start <= before.st_size)
                            zeros(content, start - offset)
                            if start == before.st_size:
                                break
                            stop = os.lseek(fd, start, os.SEEK_HOLE)
                            require(start < stop <= before.st_size)
                            extent = {"offset": start, "bytes": stop - start, "storedOffset": stored}
                            extents.append(extent)
                            require(len(packed(extents)) <= bounds["maxMetadataBytes"])
                            os.lseek(fd, start, os.SEEK_SET)
                            offset = start
                            while offset < stop:
                                guard()
                                value = os.read(fd, min(bounds["readBytes"], stop - offset))
                                require(value and len(value) <= stop - offset)
                                write_all(data_fd, value, guard)
                                content.update(value); encoded.update(value)
                                offset += len(value); stored += len(value)
                        os.fsync(data_fd)
                        guard()
                        require(os.fstat(data_fd).st_size == stored)
                        entry.update(kind="file", bytes=before.st_size, sha256=content.hexdigest(),
                                     data=data_name, dataBytes=stored, dataSha256=encoded.hexdigest(), extents=extents)
                    finally:
                        os.close(data_fd)
                    hardlinks[key] = {"count": 1, "links": before.st_nlink, "identity": identity(before),
                                      "target": {"root": root, "path": relative}}
                require(identity(before) == identity(os.fstat(fd))
                        == identity(os.stat(name, dir_fd=parent, follow_symlinks=False)))
                guard(); append(entry)
            finally:
                os.close(fd)

        def walk(root, fd, relative, source_mount, depth):
            require(depth <= 128 and mount_id(fd) == source_mount)
            before = os.fstat(fd)
            require(stat.S_ISDIR(before.st_mode))
            append({"root": root, "path": relative, "kind": "directory",
                    **metadata(before, fd, bounds["maxMetadataBytes"], uids, gids)})
            for name in sorted(os.listdir(fd)):
                guard()
                child = valid_path(posixpath.join(relative, name))
                info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode):
                    child_fd = source_open(fd, name, True)
                    try:
                        require(identity(info) == identity(os.fstat(child_fd)))
                        walk(root, child_fd, child, source_mount, depth + 1)
                        require(identity(info) == identity(os.fstat(child_fd))
                                == identity(os.stat(name, dir_fd=fd, follow_symlinks=False)))
                    finally:
                        os.close(child_fd)
                elif stat.S_ISREG(info.st_mode):
                    regular(root, fd, name, child, info, source_mount)
                elif stat.S_ISLNK(info.st_mode):
                    link_fd = os.open(name, os.O_PATH | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
                    try:
                        require(mount_id(link_fd) == source_mount and identity(info) == identity(os.fstat(link_fd)))
                        target = os.readlink(name, dir_fd=fd)
                        require(not target.startswith("/") and "\0" not in target and len(target.encode("utf8")) <= 4096)
                        # Linux cannot fgetxattr an O_PATH symlink. Inspect the
                        # no-follow name under the pinned parent, then recheck
                        # both identities. No symlink xattr profile is qualified.
                        require(not os.listxattr(f"/proc/self/fd/{fd}/{name}", follow_symlinks=False))
                        require(identity(info) == identity(os.stat(name, dir_fd=fd, follow_symlinks=False)))
                        require(identity(info) == identity(os.fstat(link_fd)))
                        append({"root": root, "path": child, "kind": "symlink", "target": target,
                                **metadata(info, None, bounds["maxMetadataBytes"], uids, gids)})
                    finally:
                        os.close(link_fd)
                else:
                    raise CutRefused()
            guard()
            require(identity(before) == identity(os.fstat(fd)))

        for name, fd in sorted(roots.items()):
            # Callers retain original anchors, but may have opened them without
            # NOATIME. Give the walk its own no-atime descriptor, including the
            # root directory itself (not only each opened child).
            walk_fd = source_open(fd, ".", True)
            try:
                require(identity(original_roots[name]) == identity(os.fstat(walk_fd))
                        and mount_id(walk_fd) == mount_id(fd))
                walk(name, walk_fd, "", mount_id(fd), 0)
                require(identity(original_roots[name]) == identity(os.fstat(fd)))
            finally: os.close(walk_fd)
        for value in hardlinks.values():
            require(value["count"] == value["links"])
        for (root, relative), entry in entries.items():
            if entry["kind"] != "symlink":
                continue
            seen = set()
            current = relative
            for _ in range(128):
                require(current not in seen)
                seen.add(current)
                candidate = entries.get((root, current))
                require(candidate is not None)
                if candidate["kind"] != "symlink":
                    break
                current = posixpath.normpath(posixpath.join(posixpath.dirname(current), candidate["target"]))
                if current == ".":
                    current = ""
                valid_path(current, True)
            else:
                raise CutRefused()
        os.fsync(inventory_fd)
        require(os.fstat(inventory_fd).st_size == inventory_bytes)
        os.fsync(destination)
        manifest = {"version": 1, "kind": "private-raw-cut", "roots": sorted(roots), "entries": len(entries),
                    "bytes": total_bytes, "inventoryBytes": inventory_bytes, "inventorySha256": inventory_hash.hexdigest(),
                    "limits": bounds}
        fd = private_file(destination, ".manifest.pending", True)
        try:
            write_all(fd, packed(manifest), guard); os.fsync(fd)
        finally:
            os.close(fd)
        guard()
        os.rename(".manifest.pending", "manifest.json", src_dir_fd=destination, dst_dir_fd=destination)
        manifest_published = True
        os.fsync(destination)
        guard()
        return manifest
    except BaseException as error:
        if manifest_published:
            try:
                os.unlink("manifest.json", dir_fd=destination); os.fsync(destination)
            except OSError:
                # No result is returned; the caller retains unconfirmed staging
                # custody. A manifest on disk is never helper retirement proof.
                pass
        if isinstance(error, CutRefused):
            raise
        raise CutRefused() from None
    finally:
        if inventory_fd is not None:
            os.close(inventory_fd)


def read_manifest(directory, guard):
    fd = private_file(directory, "manifest.json")
    try:
        guard(); before = os.fstat(fd)
        require(0 < before.st_size <= MAX_ITEM)
        value = os.read(fd, MAX_ITEM + 1)
        require(len(value) == before.st_size)
        result = closed_json(value)
        require(set(result) == {"version", "kind", "roots", "entries", "bytes", "inventoryBytes", "inventorySha256", "limits"})
        require(type(result["version"]) is int and result["version"] == 1 and result["kind"] == "private-raw-cut")
        bounds = limits(result["limits"])
        require(type(result["roots"]) is list and 1 <= len(result["roots"]) <= 16
                and result["roots"] == sorted(set(result["roots"])) and all(ROOT_NAME.fullmatch(name) for name in result["roots"]))
        require(integer(result["entries"], 1, bounds["maxEntries"]) and integer(result["bytes"], 0, bounds["maxBytes"])
                and integer(result["inventoryBytes"], 1, bounds["maxEntries"] * MAX_ITEM)
                and re.fullmatch(r"[a-f0-9]{64}", result["inventorySha256"]))
        require(identity(before) == identity(os.fstat(fd))
                == identity(os.stat("manifest.json", dir_fd=directory, follow_symlinks=False)))
        guard(); return result
    except (OSError, ValueError, TypeError, KeyError):
        raise CutRefused() from None
    finally:
        os.close(fd)


def read_raw_inventory(directory, guard):
    """Bounded streaming reader; the hash is verified before any row is yielded.
    The immutable original descriptor stays held through the entire iteration.
    """
    fd = None
    try:
        manifest = read_manifest(directory, guard)
        fd = private_file(directory, "inventory.jsonl")
        before = os.fstat(fd)
        require(before.st_size == manifest["inventoryBytes"])
        digest = hashlib.sha256()
        remaining = before.st_size
        while remaining:
            guard()
            value = os.read(fd, min(MAX_READ, remaining))
            require(value)
            digest.update(value); remaining -= len(value)
        require(digest.hexdigest() == manifest["inventorySha256"])
        os.lseek(fd, 0, os.SEEK_SET)
        count = 0
        seen = {}
        data_names = set()
        total_bytes = 0
        with os.fdopen(os.dup(fd), "rb") as stream:
            while True:
                guard()
                line = stream.readline(MAX_ITEM + 1)
                if not line:
                    break
                require(len(line) <= MAX_ITEM and line.endswith(b"\n"))
                entry = closed_json(line)
                checked_entry(entry, manifest["limits"])
                require(entry["root"] in manifest["roots"])
                key = (entry["root"], entry["path"])
                require(key not in seen and count < manifest["entries"])
                if entry["path"]:
                    parent = seen.get((entry["root"], posixpath.dirname(entry["path"])))
                    require(parent is not None and parent["kind"] == "directory")
                else:
                    require(entry["kind"] == "directory")
                if entry["kind"] == "file":
                    require(entry["data"] not in data_names)
                    data_names.add(entry["data"])
                    total_bytes += entry["bytes"]
                    require(total_bytes <= manifest["bytes"])
                if entry["kind"] == "hardlink":
                    target = seen.get((entry["target"]["root"], entry["target"]["path"]))
                    require(target is not None and target["kind"] == "file"
                            and all(entry[name] == target[name] for name in META_KEYS))
                seen[key] = entry; count += 1
                require(identity(before) == identity(os.fstat(fd))
                        == identity(os.stat("inventory.jsonl", dir_fd=directory, follow_symlinks=False)))
                yield entry
        require(count == manifest["entries"] and total_bytes == manifest["bytes"]
                and all((root, "") in seen for root in manifest["roots"])
                and identity(before) == identity(os.fstat(fd)))
        for (root, relative), entry in seen.items():
            if entry["kind"] != "symlink":
                continue
            current, visited = relative, set()
            for _ in range(128):
                require(current not in visited)
                visited.add(current)
                candidate = seen.get((root, current))
                require(candidate is not None)
                if candidate["kind"] != "symlink":
                    break
                current = posixpath.normpath(posixpath.join(posixpath.dirname(current), candidate["target"]))
                if current == ".": current = ""
                valid_path(current, True)
            else:
                raise CutRefused()
        guard()
    except (OSError, ValueError, TypeError, KeyError):
        raise CutRefused() from None
    finally:
        if fd is not None:
            os.close(fd)


def checked_entry(entry, bounds, uids=None, gids=None):
    require(type(entry) is dict and type(entry.get("root")) is str and ROOT_NAME.fullmatch(entry["root"]))
    valid_path(entry.get("path"), True)
    variants = {"directory": set(), "symlink": {"target"}, "hardlink": {"target"},
                "file": {"bytes", "sha256", "data", "dataBytes", "dataSha256", "extents"}}
    kind = entry.get("kind")
    require(type(kind) is str and kind in variants and set(entry) == {"root", "path", "kind"} | META_KEYS | variants[kind])
    require(integer(entry["mode"], 0, 0o1777) and integer(entry["uid"], 0, 2 ** 32 - 2)
            and integer(entry["gid"], 0, 2 ** 32 - 2)
            and integer(entry["atimeNs"], -(2 ** 63), 2 ** 63 - 1)
            and integer(entry["mtimeNs"], -(2 ** 63), 2 ** 63 - 1))
    require((uids is None or entry["uid"] in uids) and (gids is None or entry["gid"] in gids))
    attributes = entry["xattrs"]
    require(type(attributes) is dict and len(packed(attributes)) <= MAX_ITEM // 2)
    size = 0
    for name, encoded in attributes.items():
        require(type(name) is str and (name.startswith("user.") or name == "system.posix_acl_access"
                or name == "system.posix_acl_default" and kind == "directory"))
        require(type(encoded) is str)
        value = base64.b64decode(encoded, validate=True)
        require(base64.b64encode(value).decode("ascii") == encoded)
        size += len(name.encode("utf8")) + len(value)
        require(size <= bounds["maxMetadataBytes"])
        if name.startswith("system.posix_acl_"):
            require(len(value) >= 28 and (len(value) - 4) % 8 == 0 and struct.unpack_from("<I", value)[0] == 2)
            tags, users, groups = [], set(), set()
            for offset in range(4, len(value), 8):
                tag, permissions, owner = struct.unpack_from("<HHI", value, offset)
                require(permissions <= 7 and tag in (1, 2, 4, 8, 16, 32))
                if tag in (2, 8):
                    owners, allowed = (users, uids) if tag == 2 else (groups, gids)
                    require(owner not in owners and owner < 2 ** 32 - 1 and (allowed is None or owner in allowed))
                    owners.add(owner)
                else:
                    require(owner == 0xffffffff and tag not in tags)
                tags.append(tag)
            require(tags == sorted(tags) and all(tag in tags for tag in (1, 4, 32))
                    and (not users and not groups or 16 in tags))
    if kind == "symlink":
        require(entry["mode"] == 0o777 and not attributes and type(entry["target"]) is str
                and 0 < len(entry["target"].encode("utf8")) <= 4096
                and not entry["target"].startswith("/") and "\0" not in entry["target"])
    elif kind == "hardlink":
        require(type(entry["target"]) is dict and set(entry["target"]) == {"root", "path"}
                and type(entry["target"]["root"]) is str and ROOT_NAME.fullmatch(entry["target"]["root"]))
        valid_path(entry["target"]["path"])
    elif kind == "file":
        require(integer(entry["bytes"], 0, bounds["maxBytes"]) and integer(entry["dataBytes"], 0, entry["bytes"])
                and type(entry["data"]) is str and DATA_NAME.fullmatch(entry["data"])
                and all(type(entry[name]) is str and DIGEST.fullmatch(entry[name]) for name in ("sha256", "dataSha256"))
                and type(entry["extents"]) is list and len(packed(entry["extents"])) <= bounds["maxMetadataBytes"])
        last = stored = 0
        for extent in entry["extents"]:
            require(type(extent) is dict and set(extent) == {"offset", "bytes", "storedOffset"}
                    and integer(extent["offset"], last, entry["bytes"])
                    and integer(extent["bytes"], 1, entry["bytes"] - extent["offset"])
                    and integer(extent["storedOffset"]) and extent["storedOffset"] == stored)
            last = extent["offset"] + extent["bytes"]; stored += extent["bytes"]
        require(stored == entry["dataBytes"])


def stream_raw_file(directory, entry, output, guard):
    """Write to an exclusively owned, empty descriptor, keeping sparse holes.
    Both encoded and logical hashes must pass before any success can publish.
    """
    fd = private_file(directory, entry["data"])
    try:
        before = os.fstat(fd)
        require(before.st_size == entry["dataBytes"] and os.fstat(output).st_size == 0)
        content, encoded = hashlib.sha256(), hashlib.sha256()
        offset = stored = 0
        zero = b"\0" * MAX_READ
        for extent in entry["extents"]:
            while offset < extent["offset"]:
                guard(); size = min(MAX_READ, extent["offset"] - offset)
                content.update(zero[:size]); offset += size
            os.lseek(output, offset, os.SEEK_SET)
            stop = offset + extent["bytes"]
            while offset < stop:
                guard(); chunk = os.read(fd, min(MAX_READ, stop - offset)); require(chunk)
                write_all(output, chunk, guard)
                content.update(chunk); encoded.update(chunk); offset += len(chunk); stored += len(chunk)
        while offset < entry["bytes"]:
            guard(); size = min(MAX_READ, entry["bytes"] - offset)
            content.update(zero[:size]); offset += size
        os.ftruncate(output, entry["bytes"])
        require(stored == before.st_size and content.hexdigest() == entry["sha256"] and encoded.hexdigest() == entry["dataSha256"]
                and identity(before) == identity(os.fstat(fd))
                == identity(os.stat(entry["data"], dir_fd=directory, follow_symlinks=False)))
        guard()
    finally:
        os.close(fd)


def materialize_raw_cut(directory, destination, guard, uids, gids):
    """Isolated, inert oracle only: never opens an engine, queue or credentials.
    No manifest/authority is written on failure. Caller retains the private
    partial destination for diagnosis; it must never be reused as a successor.
    """
    try:
        manifest = read_manifest(directory, guard)
        original = os.fstat(destination)
        require(stat.S_ISDIR(original.st_mode) and original.st_uid == os.geteuid()
                and stat.S_IMODE(original.st_mode) == 0o700 and not os.listdir(destination))
        target_mount = mount_id(destination)
        directories, entries = [], {}

        def parent(root, relative):
            current = os.dup(destination)
            try:
                components = [root, *relative.split("/")] if relative else [root]
                for component in components[:-1]:
                    child = source_open(current, component, True)
                    os.close(current); current = child
                    require(mount_id(current) == target_mount)
                return current, components[-1]
            except BaseException:
                os.close(current); raise

        def apply_metadata(fd, entry):
            info = os.fstat(fd)
            if (info.st_uid, info.st_gid) != (entry["uid"], entry["gid"]):
                os.fchown(fd, entry["uid"], entry["gid"])
            os.fchmod(fd, entry["mode"])
            for name, value in entry["xattrs"].items(): os.setxattr(fd, name, base64.b64decode(value, validate=True))
            os.utime(fd, ns=(entry["atimeNs"], entry["mtimeNs"]))
            require(stat.S_IMODE(os.fstat(fd).st_mode) == entry["mode"])
            os.fsync(fd); guard()

        for entry in read_raw_inventory(directory, guard):
            checked_entry(entry, manifest["limits"], uids, gids)
            fd, name = parent(entry["root"], entry["path"])
            try:
                kind = entry["kind"]
                if kind == "directory":
                    os.mkdir(name, 0o700, dir_fd=fd); directories.append(entry)
                elif kind == "file":
                    output = os.open(name, os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=fd)
                    try:
                        stream_raw_file(directory, entry, output, guard)
                        apply_metadata(output, entry)
                    finally: os.close(output)
                elif kind == "hardlink":
                    link = entry["target"]
                    other_fd, other_name = parent(link["root"], link["path"])
                    try: os.link(other_name, name, src_dir_fd=other_fd, dst_dir_fd=fd, follow_symlinks=False)
                    finally: os.close(other_fd)
                else:
                    os.symlink(entry["target"], name, dir_fd=fd)
                    os.chown(name, entry["uid"], entry["gid"], dir_fd=fd, follow_symlinks=False)
                    os.utime(name, ns=(entry["atimeNs"], entry["mtimeNs"]), dir_fd=fd, follow_symlinks=False)
                entries[(entry["root"], entry["path"])] = entry["kind"]
                os.fsync(fd); guard()
            finally: os.close(fd)
        # Directory times and restrictive modes are applied only after children.
        for entry in reversed(directories):
            fd, name = parent(entry["root"], entry["path"])
            try:
                child = source_open(fd, name, True)
                try: apply_metadata(child, entry)
                finally: os.close(child)
            finally: os.close(fd)
        require(read_manifest(directory, guard) == manifest and mount_id(destination) == target_mount)
        os.fsync(destination); guard()
        return {"version": 1, "kind": "inert-raw-cut", "inventorySha256": manifest["inventorySha256"], "entries": len(entries)}
    except (OSError, ValueError, TypeError, KeyError):
        raise CutRefused() from None


def read_raw_file(directory, root, relative, guard, max_bytes=64 * 1024 * 1024):
    """Small-file oracle. Native image materialization uses streaming reads.
    This helper has an explicit allocation bound and never follows archive links.
    """
    try:
        entries = {}
        for entry in read_raw_inventory(directory, guard):
            entries[(entry["root"], entry["path"])] = entry
        entry = entries[(root, relative)]
        if entry["kind"] == "hardlink":
            entry = entries[(entry["target"]["root"], entry["target"]["path"])]
        require(entry["kind"] == "file" and integer(entry["bytes"], 0, max_bytes))
        require(DATA_NAME.fullmatch(entry["data"]))
        fd = private_file(directory, entry["data"])
        try:
            before = os.fstat(fd)
            require(before.st_size == entry["dataBytes"])
            value = bytearray(entry["bytes"])
            encoded = hashlib.sha256()
            stored = last = 0
            for extent in entry["extents"]:
                require(set(extent) == {"offset", "bytes", "storedOffset"}
                        and integer(extent["offset"], last, entry["bytes"])
                        and integer(extent["bytes"], 1, entry["bytes"] - extent["offset"])
                        and extent["storedOffset"] == stored)
                offset = extent["offset"]
                stop = offset + extent["bytes"]
                while offset < stop:
                    guard()
                    chunk = os.read(fd, min(MAX_READ, stop - offset))
                    require(chunk)
                    value[offset:offset + len(chunk)] = chunk
                    encoded.update(chunk); offset += len(chunk); stored += len(chunk)
                last = stop
            require(stored == before.st_size and encoded.hexdigest() == entry["dataSha256"]
                    and hashlib.sha256(value).hexdigest() == entry["sha256"])
            require(identity(before) == identity(os.fstat(fd))
                    == identity(os.stat(entry["data"], dir_fd=directory, follow_symlinks=False)))
            guard(); return bytes(value)
        finally:
            os.close(fd)
    except (OSError, ValueError, TypeError, KeyError):
        raise CutRefused() from None
