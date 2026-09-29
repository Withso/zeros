import { createServer, type Server as HttpServer } from "node:http";
import { createServer as createNetServer, type Socket } from "node:net";

/** A SOCKS5 handshake over a Unix socket connects libcurl directly to our
 * HTTP parser. There is no TCP listener and no general network forwarding.
 * SO_PEERCRED on the resulting request still identifies the actual Git child,
 * so another terminal cannot borrow authority through a local TCP relay. */
export function nativeGithubGitSocket(http: HttpServer = createServer()) {
  const sockets = new Set<Socket>();
  const server = createNetServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.setTimeout(10000, () => socket.destroy());
    let buffer = Buffer.alloc(0),
      stage = 0;
    const receive = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 4096) {
        socket.destroy();
        return;
      }
      if (stage === 0) {
        if (buffer.length < 2) return;
        const count = buffer[1]!;
        if (buffer[0] !== 5 || !count || count > 16) {
          socket.destroy();
          return;
        }
        if (buffer.length < 2 + count) return;
        if (!buffer.subarray(2, 2 + count).includes(0)) {
          socket.destroy();
          return;
        }
        buffer = buffer.subarray(2 + count);
        stage = 1;
        socket.write(Buffer.from([5, 0]));
      }
      if (buffer.length < 5) return;
      if (
        buffer[0] !== 5 ||
        buffer[1] !== 1 ||
        buffer[2] !== 0 ||
        buffer[3] !== 3
      ) {
        socket.destroy();
        return;
      }
      const length = buffer[4]!,
        end = 5 + length + 2;
      if (buffer.length < end) return;
      if (
        buffer.subarray(5, 5 + length).toString("ascii") !==
          "github.zeros.invalid" ||
        buffer.readUInt16BE(5 + length) !== 80
      ) {
        socket.destroy();
        return;
      }
      socket.pause();
      socket.off("data", receive);
      socket.setTimeout(0);
      socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
      if (buffer.length > end) socket.unshift(buffer.subarray(end));
      http.emit("connection", socket);
      socket.resume();
    };
    socket.on("data", receive);
  });
  server.maxConnections = 16;
  return {
    server,
    close: () => {
      for (const socket of sockets) socket.destroy();
      http.closeAllConnections();
    },
  };
}
