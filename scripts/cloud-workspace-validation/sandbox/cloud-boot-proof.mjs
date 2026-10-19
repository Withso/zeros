import * as fs from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { parseCloudV4Document } from "./attest-cloud-worker.mjs";

const DIRECTORY = "/run/zeros";
const PROOF = `${DIRECTORY}/cloud-worker-admission.json`;
const MAX_BYTES = 16384;
const refused = () => new Error("Cloud boot launch proof refused");
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.gid === b.gid && a.mode === b.mode && a.nlink === b.nlink;

/** Fixed paths only. The filesystem seam is for portable original-inode tests. */
export function cloudBootProofStore(io = fs) {
  const directory = () => {
    for (let cursor = DIRECTORY; ; cursor = path.dirname(cursor)) {
      const stat = io.lstatSync(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || stat.gid !== 0 || stat.mode & 0o022 ||
          cursor === DIRECTORY && stat.mode & 0o7077 || io.realpathSync(cursor) !== cursor) throw refused();
      if (cursor === "/") break;
    }
    return io.lstatSync(DIRECTORY);
  };
  const stable = original => { if (!same(original, directory())) throw refused(); };
  const read = file => {
    const fd = io.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const stat = io.fstatSync(fd), current = io.lstatSync(file);
      if (!stat.isFile() || stat.uid !== 0 || stat.gid !== 0 || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o400 ||
          current.isSymbolicLink() || !same(stat, current) || stat.size < 2 || stat.size > MAX_BYTES) throw refused();
      const bytes = Buffer.alloc(stat.size + 1); let size = 0;
      while (size < bytes.length) {
        const count = io.readSync(fd, bytes, size, bytes.length - size, null);
        if (!count) break; size += count;
      }
      if (size !== stat.size || !same(stat, io.fstatSync(fd)) || !same(stat, io.lstatSync(file))) throw refused();
      return parseCloudV4Document(bytes.subarray(0, size), "launch_proof");
    } finally { io.closeSync(fd); }
  };
  return {
    clear() { directory(); io.rmSync(PROOF, { force: true }); },
    publish(value) {
      const original = directory(), bytes = Buffer.from(`${JSON.stringify(value)}\n`);
      if (bytes.length > MAX_BYTES || bytes.length < 2) throw refused();
      const temporary = `${PROOF}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`;
      let fd;
      try {
        fd = io.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o400);
        io.fchownSync(fd, 0, 0); io.fchmodSync(fd, 0o400);
        io.writeFileSync(fd, bytes); io.fsyncSync(fd);
        const stat = io.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== 0 || stat.gid !== 0 || (stat.mode & 0o7777) !== 0o400 ||
            stat.size !== bytes.length || !same(stat, io.lstatSync(temporary))) throw refused();
        stable(original); io.renameSync(temporary, PROOF); stable(original);
      } finally { if (fd !== undefined) io.closeSync(fd); io.rmSync(temporary, { force: true }); }
    },
    async consume(validate) {
      const original = directory(), consumed = `${DIRECTORY}/.cloud-worker-admission.${process.pid}.${randomBytes(12).toString("hex")}.consumed`;
      // All validation, including expected scope validation, follows this
      // atomic claim. A malformed/refused proof is spent, even on exceptions.
      io.renameSync(PROOF, consumed);
      try { stable(original); return await validate(read(consumed)); }
      finally { io.rmSync(consumed, { force: true }); }
    },
  };
}
