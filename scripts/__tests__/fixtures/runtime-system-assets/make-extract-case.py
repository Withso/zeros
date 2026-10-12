"""Construct small synthetic Debian archives for extraction preflight tests."""
import io
import json
import sys
import tarfile


def tar_bytes(members):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as archive:
        for member in members:
            entry = tarfile.TarInfo(member["name"])
            entry.mode = int(member.get("mode", "0644"), 8)
            entry.uid, entry.gid = member.get("uid", 0), member.get("gid", 0)
            entry.type = {"directory": tarfile.DIRTYPE, "symlink": tarfile.SYMTYPE}.get(member.get("type"), tarfile.REGTYPE)
            entry.linkname = member.get("target", "")
            data = member.get("data", "").encode()
            entry.size = len(data)
            archive.addfile(entry, io.BytesIO(data))
    return output.getvalue()


with open(sys.argv[1], "wb") as output:
    output.write(b"!<arch>\n")
    control = "Package: fixture\nVersion: 1.0\nArchitecture: all\nMaintainer: Fixture <fixture@example.invalid>\nDescription: extraction fixture\n"
    for name, content in [("debian-binary", b"2.0\n"),
                          ("control.tar.gz", tar_bytes([{"name": "./control", "data": control}])),
                          ("data.tar.gz", tar_bytes(json.load(sys.stdin)))]:
        output.write(f"{name + '/':<16}{0:<12}{0:<6}{0:<6}{'100644':<8}{len(content):<10}`\n".encode())
        output.write(content)
        if len(content) % 2:
            output.write(b"\n")
