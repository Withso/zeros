#!/usr/bin/python3 -I
"""Fixed Git askpass. The credential exists only in the clone helper's memory."""
import os
from pathlib import Path
import re
import socket
import stat
import struct
import sys

try:
    address = os.environ.get("ZEROS_COMPUTER_ASKPASS_SOCKET", "")
    assert re.fullmatch(r"/run/zeros/computer-build/[a-f0-9-]{36}/git-credential.sock", address)
    parent = Path(address).parent.lstat()
    assert stat.S_ISDIR(parent.st_mode) and parent.st_uid == 0 and stat.S_IMODE(parent.st_mode) == 0o700
    assert len(sys.argv) == 2
    prompt = sys.argv[1].lower()
    question = b"username" if prompt.startswith("username") else b"password" if prompt.startswith("password") else None
    assert question is not None
    with socket.socket(socket.AF_UNIX) as connection:
        connection.settimeout(5)
        connection.connect(address)
        assert struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))[1] == 0
        connection.sendall(question)
        value = connection.recv(4097)
        assert 0 < len(value) <= 4096 and b"\n" not in value and b"\r" not in value and b"\0" not in value
        sys.stdout.buffer.write(value + b"\n")
except BaseException:
    sys.exit(1)
