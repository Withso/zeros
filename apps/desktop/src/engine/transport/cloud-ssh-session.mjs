import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const MAX_SESSIONS = 4;
const MAX_COMMAND_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

export function assertCloudSshWorkerIdentity(status, identity) {
  if (identity.platform !== 'linux' || identity.uid !== 10001 || identity.gid !== 10001 ||
      identity.groups.some(group => group !== 10001) ||
      !/^NoNewPrivs:\s+1$/m.test(status) || !/^CapEff:\s+0+$/m.test(status)) {
    throw new Error('SSH requires the unprivileged cloud worker');
  }
}

/** SSH protocol parsing and every shell run under the workload identity. This
 * accepts an already authorized byte stream; it never opens a TCP listener.
 * The parent owns the short Zeros access lease and closes stdin on revocation.
 * No provider credential or control-plane capability enters this process. */
export function createCloudSshSession(stream, options) {
  const { Server, utils } = require('ssh2');
  const keys = utils.generateKeyPairSync('ed25519');
  const parsed = utils.parseKey(keys.public);
  const fingerprint = createHash('sha256').update(parsed.getPublicSSH()).digest('base64').replace(/=+$/, '');
  const server = new Server({ hostKeys: [keys.private], ident: 'ZerosCloud', highWaterMark: 32 * 1024 });
  const channels = new Set();
  let connection;
  let started = false;
  let closed = false;
  let outputBytes = 0;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(handshake);
    for (const cleanup of [...channels]) cleanup();
    connection?.end();
    stream.destroy();
    server.close();
  };
  const handshake = setTimeout(close, 10_000);
  handshake.unref();
  stream.once('error', close);
  stream.once('close', close);
  server.on('error', close);
  server.on('connection', client => {
    connection = client;
    client.on('error', close);
    client.once('close', close);
    // WSS admission is the authentication boundary. An SSH username cannot
    // select a Unix identity, and password/key/agent forwarding is unavailable.
    client.on('authentication', context => {
      if (!closed && context.method === 'none' && context.username === 'zeros') context.accept();
      else context.reject(['none']);
    });
    client.on('tcpip', (_accept, reject) => reject());
    client.on('request', (_accept, reject) => reject?.());
    client.on('ready', () => {
      clearTimeout(handshake);
      client.on('session', (accept, reject) => {
        if (closed || channels.size >= MAX_SESSIONS) { reject(); return; }
        const session = accept();
        let running = false;
        let disposed = false;
        let terminal;
        let process;
        let channel;
        let dimensions = null;
        let outputPending = 0;
        const dispose = () => {
          if (disposed) return;
          disposed = true;
          channels.delete(dispose);
          try { terminal?.kill(); } catch { /* already exited */ }
          if (process && process.exitCode === null) process.kill('SIGKILL');
          channel?.destroy();
        };
        channels.add(dispose);
        session.on('error', dispose);
        session.once('close', dispose);
        session.on('env', (_accept, reject) => reject?.());
        session.on('x11', (_accept, reject) => reject?.());
        session.on('auth-agent', (_accept, reject) => reject?.());
        const validDimensions = info => Number.isSafeInteger(info.cols) && info.cols >= 1 && info.cols <= 500 &&
          Number.isSafeInteger(info.rows) && info.rows >= 1 && info.rows <= 300;
        session.on('pty', (accept, reject, info) => {
          if (running || dimensions || !validDimensions(info) || !/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,63}$/.test(info.term)) { reject?.(); return; }
          dimensions = { cols: info.cols, rows: info.rows, name: info.term };
          accept?.();
        });
        session.on('window-change', (accept, reject, info) => {
          if (!terminal || !validDimensions(info)) { reject?.(); return; }
          terminal.resize(info.cols, info.rows); accept?.();
        });
        session.on('signal', (accept, reject, info) => {
          if (!['INT', 'TERM', 'HUP'].includes(info.name)) { reject?.(); return; }
          try {
            if (terminal) terminal.kill('SIG' + info.name);
            else if (process) process.kill('SIG' + info.name);
            else { reject?.(); return; }
            accept?.();
          } catch { reject?.(); }
        });
        const start = (accept, reject, command, subsystem = false) => {
          if (closed || disposed || running || (command !== null &&
              (typeof command !== 'string' || Buffer.byteLength(command) > MAX_COMMAND_BYTES || command.includes('\0')))) { reject?.(); return; }
          if (subsystem && (!options.sftpServer || dimensions)) { reject?.(); return; }
          running = true;
          channel = accept();
          channel.once('close', dispose);
          channel.on('error', dispose);
          const outputAllowed = data => {
            outputBytes += Buffer.byteLength(data);
            if (outputBytes > MAX_OUTPUT_BYTES) { close(); return false; }
            return !closed && !disposed;
          };
          try {
            if (dimensions) {
              const pty = options.spawnPty ?? require('node-pty').spawn;
              terminal = pty('/bin/bash', command === null ? ['-l'] : ['-lc', command], {
                cwd: options.cwd, env: { ...options.env, TERM: dimensions.name }, ...dimensions,
              });
              terminal.onData(data => {
                if (!outputAllowed(data)) return;
                const bytes = Buffer.byteLength(data);
                outputPending += bytes;
                if (outputPending > 1024 * 1024) { close(); return; }
                if (!channel.write(data, () => { outputPending -= bytes; })) terminal.pause();
              });
              channel.on('drain', () => terminal?.resume());
              terminal.onExit(({ exitCode }) => { if (!disposed) { channel.exit(exitCode); channel.end(); } });
              // SSH packets can split a UTF-8 codepoint. node-pty accepts raw
              // bytes, so decoding each packet here would corrupt input.
              channel.on('data', data => terminal.write(data));
              channel.once('end', () => { try { terminal.kill('SIGHUP'); } catch { /* already exited */ } });
            } else {
              const executable = subsystem ? options.sftpServer : '/bin/bash';
              const args = subsystem ? ['-d', options.cwd, '-u', '0022'] : command === null ? ['-l'] : ['-lc', command];
              process = (options.spawnProcess ?? spawn)(executable, args, {
                cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'],
              });
              process.once('error', () => { if (!disposed) { channel.exit(127); channel.end(); } });
              process.stdout.on('data', data => outputAllowed(data));
              process.stderr.on('data', data => outputAllowed(data));
              channel.pipe(process.stdin);
              process.stdin.on('error', () => {});
              process.stdout.pipe(channel, { end: false });
              process.stderr.pipe(channel.stderr, { end: false });
              process.once('close', (code, signal) => {
                if (!disposed) { channel.exit(Number.isInteger(code) ? code : signal ? 128 : 1); channel.end(); }
              });
            }
          } catch {
            if (!disposed) { channel.exit(127); channel.end(); }
          }
        };
        session.on('shell', (accept, reject) => start(accept, reject, null));
        session.on('exec', (accept, reject, info) => start(accept, reject, info.command));
        session.on('subsystem', (accept, reject, info) => {
          if (info.name !== 'sftp') { reject?.(); return; }
          start(accept, reject, null, true);
        });
      });
    });
  });
  return {
    publicKey: keys.public,
    hostKeySha256: fingerprint,
    start() { if (closed || started) throw new Error('SSH session is not available'); started = true; server.injectSocket(stream); },
    close,
  };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assertCloudSshWorkerIdentity(readFileSync('/proc/self/status', 'utf8'), {
      platform: process.platform, uid: process.getuid(), gid: process.getgid(), groups: process.getgroups(),
    });
    const cwd = '/srv/zeros/workspace';
    if (realpathSync(cwd) !== cwd) throw new Error('SSH workspace is unavailable');
    const stream = Duplex.from({ readable: process.stdin, writable: process.stdout });
    const session = createCloudSshSession(stream, {
      cwd,
      sftpServer: '/usr/lib/openssh/sftp-server',
      env: { HOME: '/srv/zeros/home/agent', PATH: '/opt/zeros-runtime/bin:/usr/local/bin:/usr/bin:/bin',
        LANG: 'C.UTF-8', USER: 'zeros-worker', LOGNAME: 'zeros-worker', SHELL: '/bin/bash' },
    });
    process.stdout.write(JSON.stringify({ version: 1, kind: 'ssh', publicKey: session.publicKey, hostKeySha256: session.hostKeySha256 }) + '\n', () => session.start());
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { session.close(); process.exit(0); });
  } catch {
    process.stderr.write('Cloud SSH worker unavailable\n');
    process.exitCode = 1;
  }
}
