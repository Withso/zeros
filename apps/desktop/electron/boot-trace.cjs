// Inlined before bundled imports by tsup. Never log argv or exception messages:
// either can contain credentials before the normal redactor has loaded.
(function () {
  if (process.type === 'renderer') return;
  try {
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zeros-boot-'));
    fs.chmodSync(directory, 0o700);
    const fd = fs.openSync(path.join(directory, 'boot.log'), fs.constants.O_WRONLY | fs.constants.O_CREAT |
      fs.constants.O_EXCL | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW || 0), 0o600);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid())) { fs.closeSync(fd); return; }
    const write = event => { try { fs.writeSync(fd, JSON.stringify({ at: new Date().toISOString(), event }) + '\n'); } catch { /* Best-effort startup diagnostics. */ } };
    write('main entered');
    // Observe without suppressing the runtime's normal fatal-exception behavior.
    process.on('uncaughtExceptionMonitor', () => write('uncaught exception'));
    process.once('exit', () => { try { fs.closeSync(fd); } catch { /* Already closed during shutdown. */ } });
  } catch { /* Diagnostics must never prevent launch. */ }
})();
