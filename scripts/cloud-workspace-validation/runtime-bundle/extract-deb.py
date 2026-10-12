"""Preflight an authenticated .deb, then extract without installation/hooks."""
import os
import pathlib
import posixpath
import re
import subprocess
import sys
import tarfile


def extract(archive, destination):
    process = subprocess.Popen(["dpkg-deb", "--fsys-tarfile", archive], stdout=subprocess.PIPE)
    entries = {}
    total = 0
    try:
        with tarfile.open(fileobj=process.stdout, mode="r|") as payload:
            for entry in payload:
                name = entry.name.removeprefix("./").rstrip("/")
                root = entry.name in (".", "./")
                if root:
                    name = ""
                # dpkg applies the root entry's metadata to the destination too.
                if (name in entries or entry.mode & 0o7000 or (not entry.issym() and entry.mode & 0o022)
                        or entry.uid != 0 or entry.gid != 0
                        or not (entry.isfile() or entry.isdir() or entry.issym())):
                    raise ValueError("Invalid package member")
                if root:
                    if not entry.isdir():
                        raise ValueError("Invalid package root")
                elif (not re.fullmatch(r"[A-Za-z0-9_+.,@%:=/-]+", name)
                      or name.startswith("/") or len(name) > 4096 or len(name.split("/")) > 128
                      or any(part in ("", ".", "..") for part in name.split("/"))):
                    raise ValueError("Invalid package member")
                if entry.issym():
                    target = entry.linkname
                    if (not re.fullmatch(r"[A-Za-z0-9_+.,@%:=/-]+", target)
                            or target.startswith("/") or len(target) > 4096 or len(target.split("/")) > 128):
                        raise ValueError("Invalid package link")
                entries[name] = entry
                total += entry.size
                if len(entries) > 10000 or total > 256 * 1024 * 1024:
                    raise ValueError("Package is too large")
        if process.wait(timeout=30) != 0:
            raise ValueError("Invalid package archive")
        for name in entries:
            parent = posixpath.dirname(name)
            while parent:
                if parent in entries and not entries[parent].isdir():
                    raise ValueError("Package traverses a link")
                parent = posixpath.dirname(parent)
            entry = entries[name]
            if entry.issym():
                parts = name.split("/")[:-1]
                for component in entry.linkname.split("/"):
                    if component in ("", "."):
                        continue
                    if component == "..":
                        if not parts:
                            raise ValueError("Invalid package link")
                        parts.pop()
                    else:
                        parts.append(component)
                        target = entries.get("/".join(parts))
                        # No link-through-link targets, even before a following
                        # '..'. This also refuses self-links and every cycle.
                        if target and target.issym():
                            raise ValueError("Package link traverses a link")
        os.mkdir(destination, 0o700)
        subprocess.run(["dpkg-deb", "-x", archive, destination], check=True, timeout=60)
    finally:
        process.stdout.close()
        if process.poll() is None:
            process.kill()
            process.wait()


if __name__ == "__main__":
    extract(str(pathlib.Path(sys.argv[1]).resolve()), str(pathlib.Path(sys.argv[2]).resolve()))
