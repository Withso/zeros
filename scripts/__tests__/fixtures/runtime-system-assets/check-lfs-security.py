"""Offline regressions against the actual runtime Git LFS executable.

Uses a fresh HOME, synthetic credentials, a loopback server, and hand-built
Git objects/indexes. No existing Git configuration or repository is consulted.
"""
import hashlib
import http.server
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import threading
import zlib


def repository(root):
    repo = root / "repo"
    (repo / ".git/objects").mkdir(parents=True)
    (repo / ".git/refs/heads").mkdir(parents=True)
    (repo / ".git/HEAD").write_text("ref: refs/heads/main\n")
    (repo / ".git/config").write_text("[core]\n repositoryformatversion = 0\n bare = false\n"
        '[filter "lfs"]\n clean = git-lfs clean -- %f\n smudge = git-lfs smudge -- %f\n'
        " process = git-lfs filter-process\n required = true\n")
    return repo


def environment(root):
    home = root / "home"
    home.mkdir()
    return {"PATH": "/usr/bin:/bin", "HOME": str(home), "XDG_CONFIG_HOME": str(home),
            "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_SYSTEM": "/dev/null",
            "GIT_TERMINAL_PROMPT": "0", "LANG": "C.UTF-8"}


def credentials(binary, injected):
    with tempfile.TemporaryDirectory(prefix="zeros-lfs-credential-") as directory:
        root = Path(directory)
        repo, env = repository(root), environment(root)
        authorized = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                auth = bool(self.headers.get("Authorization"))
                authorized.append(auth)
                self.send_response(200 if auth else 401)
                self.send_header("Content-Type", "application/json")
                self.send_header("WWW-Authenticate", 'Basic realm="fixture"')
                self.end_headers()
                self.wfile.write(b'{"locks":[],"next_cursor":""}')

            def log_message(self, *_):
                pass

        server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        helper = root / "credential-fixture.py"
        helper.write_text("#!/usr/bin/python3\nimport json,pathlib,sys\n"
            "fields=dict(line.split('=',1) for line in sys.stdin.read().splitlines() if '=' in line)\n"
            "with pathlib.Path(" + repr(str(root / "helper.jsonl")) + ").open('a') as out:\n"
            " out.write(json.dumps({'host':fields.get('host'),'operation':sys.argv[1]})+'\\n')\n"
            "if sys.argv[1]=='get' and fields.get('host')=='trusted.example.test':\n"
            " print('username=fixture\\npassword=synthetic-placeholder\\n')\n")
        helper.chmod(0o700)
        suffix = "repo%0ahost=trusted.example.test" if injected else "repo"
        with (repo / ".git/config").open("a") as output:
            output.write('[remote "origin"]\n url = https://original.example.test/repo.git\n'
                '[lfs]\n url = http://127.0.0.1:' + str(server.server_port) + '/' + suffix + '\n'
                '[credential]\n helper = ' + str(helper) + '\n useHttpPath = true\n')
        try:
            process = subprocess.run([binary, "locks"], cwd=repo, env=env, capture_output=True, timeout=15)
            calls = root / "helper.jsonl"
            values = [json.loads(line) for line in calls.read_text().splitlines()] if calls.exists() else []
            return {"helperCalled": bool(values), "foreignHostRequested": any(row["host"] == "trusted.example.test" for row in values),
                    "authorizationSent": any(authorized), "requests": len(authorized), "exitCode": process.returncode}
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


def object_id(repo, kind, data):
    raw = kind.encode() + b" " + str(len(data)).encode() + b"\0" + data
    digest = hashlib.sha1(raw).hexdigest()
    target = repo / ".git/objects" / digest[:2] / digest[2:]
    target.parent.mkdir(exist_ok=True)
    target.write_bytes(zlib.compress(raw))
    return bytes.fromhex(digest)


def checkout(binary, link):
    with tempfile.TemporaryDirectory(prefix="zeros-lfs-checkout-") as directory:
        root = Path(directory)
        repo, env = repository(root), environment(root)
        payload = b"synthetic hydrated LFS contents\n"
        digest = hashlib.sha256(payload).hexdigest()
        pointer = ("version https://git-lfs.github.com/spec/v1\noid sha256:" + digest + "\nsize " + str(len(payload)) + "\n").encode()
        objects = repo / ".git/lfs/objects" / digest[:2] / digest[2:4]
        objects.mkdir(parents=True)
        (objects / digest).write_bytes(payload)
        attributes = b"*.bin filter=lfs diff=lfs merge=lfs -text\n"
        (repo / ".gitattributes").write_bytes(attributes)
        tracked = [(".gitattributes", attributes), ("dir/file.bin", pointer)]
        ids = {name: object_id(repo, "blob", data) for name, data in tracked}
        tree = object_id(repo, "tree", b"100644 file.bin\0" + ids["dir/file.bin"])
        tree = object_id(repo, "tree", b"100644 .gitattributes\0" + ids[".gitattributes"] + b"40000 dir\0" + tree)
        commit = object_id(repo, "commit", b"tree " + tree.hex().encode() +
            b"\nauthor Fixture <fixture@example.test> 1 +0000\ncommitter Fixture <fixture@example.test> 1 +0000\n\nfixture\n")
        (repo / ".git/refs/heads/main").write_text(commit.hex() + "\n")
        index = b"DIRC" + struct.pack("!II", 2, len(tracked))
        for name, data in tracked:
            entry = struct.pack("!10I", 0, 0, 0, 0, 0, 0, 0o100644, 0, 0, len(data)) + ids[name]
            entry += struct.pack("!H", len(name)) + name.encode() + b"\0"
            index += entry + b"\0" * ((-len(entry)) % 8)
        (repo / ".git/index").write_bytes(index + hashlib.sha1(index).digest())
        outside = root / "outside"
        outside.mkdir()
        target = outside / "file.bin"
        target.write_bytes(pointer)
        if link == "directory-symlink":
            (repo / "dir").symlink_to(outside, target_is_directory=True)
        else:
            (repo / "dir").mkdir()
            if link == "file-symlink": (repo / "dir/file.bin").symlink_to(target)
            elif link == "hardlink": os.link(target, repo / "dir/file.bin")
            else: (repo / "dir/file.bin").write_bytes(pointer)
        process = subprocess.run([binary, "checkout"], cwd=repo, env=env, capture_output=True, timeout=15)
        return {"outsideUnchanged": target.read_bytes() == pointer,
                "worktreeHydrated": (repo / "dir/file.bin").read_bytes() == payload,
                "exitCode": process.returncode}


if __name__ == "__main__":
    binary, case = sys.argv[1:]
    result = credentials(binary, case == "credential-injection") if case.startswith("credential-") else checkout(binary, case)
    print(json.dumps(result, sort_keys=True))
