"""Execute the private evidence collector locally without provider access."""
import contextlib
import importlib.util
import io
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

sys.dont_write_bytecode = True
SOURCE = Path(__file__).resolve().parents[2] / "boat-image/templates/v4/evidence.py"
SPEC = importlib.util.spec_from_file_location("evidence", SOURCE)
evidence = importlib.util.module_from_spec(SPEC)
with contextlib.redirect_stdout(io.StringIO()):
    SPEC.loader.exec_module(evidence)


class EvidenceTests(unittest.TestCase):
    def test_command_tail_bounds_streams_and_discards_a_partial_first_line(self):
        result = evidence.command_tail([sys.executable, "-I", "-c", "print('x' * 200000); print('kept final line')"])
        self.assertEqual(result, b"kept final line\n")

    def test_file_tail_bounds_reads_and_refuses_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            log = root / "build.log"
            log.write_bytes(b"x" * 200000 + b"\nkept final line\n")
            original = os.fstat
            def owned(fd):
                fields = list(original(fd))
                fields[4] = 0  # Only ownership is injected for this rootless read.
                return os.stat_result(fields)
            with mock.patch.object(evidence.os, "fstat", side_effect=owned):
                self.assertEqual(evidence.file_tail(str(log)), b"kept final line\n")
                alias = root / "alias"
                alias.symlink_to(log)
                with self.assertRaises(OSError):
                    evidence.file_tail(str(alias))
                parent = root / "linked-parent"
                parent.symlink_to(root, target_is_directory=True)
                with self.assertRaises(OSError):
                    evidence.file_tail(str(parent / "build.log"))


if __name__ == "__main__":
    unittest.main()
