"""Native mount-table model for temporary-root tests; never performs mounts."""
import contextlib
import os
from pathlib import Path
from unittest import mock


class NativeMounts:
    def __init__(self, root, split=None):
        self.root = Path(root)
        self.objects, self.entries, self.fds = [], {}, {}
        self.add("/")
        if split:
            self.add(split)

    def add(self, path, filesystem="ext4"):
        used = {entry["id"] for entry in self.objects if entry["attached"] or entry["refs"]}
        number = next(number for number in range(101, 1000) if number not in used)
        entry = dict(id=number, path=path, filesystem=filesystem, refs=0,
                     attached=True, generation=len(self.objects))
        self.objects.append(entry)
        self.entries[path] = entry
        return entry

    def replace(self, path):
        old = self.entries.pop(path)
        old["attached"] = False
        return old, self.add(path, old["filesystem"])

    def logical(self, fd):
        path = Path(os.readlink(f"/proc/self/fd/{fd}")).relative_to(self.root).as_posix()
        return "/" if path == "." else "/" + path

    def entry(self, fd):
        path = self.logical(fd)
        return max((entry for name, entry in self.entries.items()
                    if name == "/" or path == name or path.startswith(name + "/")), key=lambda e: len(e["path"]))

    def mount_id(self, fd):
        return (self.fds[fd] if fd in self.fds else self.entry(fd))["id"]

    def table(self):
        device = os.stat(self.root).st_dev
        return [dict(id=entry["id"], device=f"{os.major(device)}:{os.minor(device)}",
                     root="/", target=str(self.root / path.lstrip("/")), options=["rw"],
                     filesystem=entry["filesystem"], source="fixture") for path, entry in self.entries.items()]

    @contextlib.contextmanager
    def track(self):
        opening, duplicating, closing = os.open, os.dup, os.close

        def opened(*args, **kwargs):
            fd = opening(*args, **kwargs)
            if not (args[1] if len(args) > 1 else kwargs["flags"]) & os.O_DIRECTORY:
                return fd
            try:
                entry = self.entry(fd)
            except (ValueError, OSError):
                return fd
            entry["refs"] += 1
            self.fds[fd] = entry
            return fd

        def duplicated(fd):
            result = duplicating(fd)
            if fd in self.fds:
                self.fds[result] = self.fds[fd]
                self.fds[result]["refs"] += 1
            return result

        def closed(fd):
            closing(fd)
            if fd in self.fds:
                self.fds.pop(fd)["refs"] -= 1

        with mock.patch.object(os, "open", side_effect=opened), mock.patch.object(os, "dup", side_effect=duplicated), \
                mock.patch.object(os, "close", side_effect=closed):
            yield self
