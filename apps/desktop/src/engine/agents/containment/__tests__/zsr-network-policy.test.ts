import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import {
  connect as connectHttp2,
  createSecureServer as createHttp2SecureServer,
} from "node:http2";
import { connect as connectTcp, type Server } from "node:net";
import { PassThrough } from "node:stream";
import { connect as connectTls, type TLSSocket } from "node:tls";

import {
  SandboxManager,
  SandboxRuntimeConfigSchema,
} from "@anthropic-ai/sandbox-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createBodySubstitutionTransform } from "../../../../../../../node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/body-substitution.js";
import {
  AwsPairRegistry,
  createSigv4Planner,
  type Sigv4Plan,
} from "../../../../../../../node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/credential-aws-pairs.js";
import { matchesDomainPatternWithPort } from "../../../../../../../node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/domain-pattern.js";

import {
  createMitmCA,
  disposeMitmCA,
  type MitmCA,
} from "../../../../../../../node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/mitm-ca.js";
import { mintLeafCert } from "../../../../../../../node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/mitm-leaf.js";
import {
  parseClientHelloAlpn,
  peekForClientHello,
} from "../../../../../../../node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/tls-terminate-proxy.js";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  return address.port;
}

it("keeps exact host:port grants on the AWS SigV4 re-signing path", () => {
  const sentinel = "fake_value_00000000-0000-4000-8000-000000000001";
  const registry = new AwsPairRegistry();
  registry.register({
    accessKeyIdSentinel: sentinel,
    realAccessKeyId: "AKIAEXAMPLE",
    realSecretAccessKey: "real-secret",
    injectHosts: ["s3.example.test:443"],
  });
  const planner = createSigv4Planner(
    registry,
    undefined,
    matchesDomainPatternWithPort,
  ) as unknown as (
    method: string,
    requestTarget: string,
    headers: Record<string, string>,
    destHost: string,
    destPort: number,
  ) => Sigv4Plan | undefined;
  const headers = {
    authorization:
      `AWS4-HMAC-SHA256 Credential=${sentinel}/20260816/us-east-1/s3/aws4_request, ` +
      `SignedHeaders=host;x-amz-date, Signature=${"0".repeat(64)}`,
    "x-amz-date": "20260816T000000Z",
  };

  expect(planner("GET", "/", headers, "s3.example.test", 443)?.action).toBe(
    "resign",
  );
  expect(planner("GET", "/", headers, "s3.example.test", 8443)).toBeUndefined();
});

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function proxyAuthorization(): string {
  const token = SandboxManager.getProxyAuthToken();
  if (!token) throw new Error("SRT proxy auth is unavailable");
  return `Basic ${Buffer.from(`srt:${token}`).toString("base64")}`;
}

async function readUntil(
  socket: NodeJS.ReadableStream,
  marker: Buffer,
  timeoutMs = 5_000,
): Promise<{ before: Buffer; after: Buffer }> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    const timer = setTimeout(
      () => finish(new Error("socket read timed out")),
      timeoutMs,
    );
    const finish = (
      error?: Error,
      value?: { before: Buffer; after: Buffer },
    ) => {
      clearTimeout(timer);
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("end", onEnd);
      socket.removeListener("close", onClose);
      if (error) reject(error);
      else if (value) resolve(value);
    };
    const onError = (error: Error) => finish(error);
    const onEnd = () => finish(new Error("socket ended before marker"));
    const onClose = () => finish(new Error("socket closed before marker"));
    const onData = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(bytes);
      length += bytes.length;
      const all = Buffer.concat(chunks, length);
      const index = all.indexOf(marker);
      if (index === -1) return;
      finish(undefined, {
        before: all.subarray(0, index + marker.length),
        after: all.subarray(index + marker.length),
      });
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("end", onEnd);
    socket.once("close", onClose);
  });
}

async function openTlsProxyTunnel(options: {
  targetPort: number;
  trustBundlePath: string;
  alpnProtocols: string[];
  servername?: string;
}): Promise<TLSSocket> {
  const proxyPort = SandboxManager.getProxyPort();
  if (!proxyPort) throw new Error("SRT proxy is unavailable");
  const tcp = connectTcp({ host: "127.0.0.1", port: proxyPort });
  await new Promise<void>((resolve, reject) => {
    tcp.once("connect", resolve);
    tcp.once("error", reject);
  });
  tcp.write(
    `CONNECT 127.0.0.1:${options.targetPort} HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${options.targetPort}\r\n` +
      `Proxy-Authorization: ${proxyAuthorization()}\r\n\r\n`,
  );
  const connected = await readUntil(tcp, Buffer.from("\r\n\r\n"));
  expect(connected.before.toString("latin1")).toMatch(/^HTTP\/1\.1 200 /);
  if (connected.after.length > 0) tcp.unshift(connected.after);

  const tls = connectTls({
    socket: tcp,
    host: "127.0.0.1",
    ca: await readFile(options.trustBundlePath),
    ALPNProtocols: options.alpnProtocols,
    ...(options.servername ? { servername: options.servername } : {}),
  });
  await new Promise<void>((resolve, reject) => {
    tls.once("secureConnect", resolve);
    tls.once("error", reject);
  });
  return tls;
}

function sandboxTrustBundle(
  wrapped: Awaited<ReturnType<typeof SandboxManager.wrapWithSandboxArgv>>,
): string {
  const command = wrapped.argv.join(" ");
  const trustBundlePath = command
    .match(/--setenv NODE_EXTRA_CA_CERTS (?:'([^']+)'|([^ ]+))/)
    ?.slice(1)
    .find(Boolean);
  if (!trustBundlePath) {
    throw new Error("SRT wrapper omitted its trust bundle");
  }
  return trustBundlePath;
}

function sandboxTrustBundleAndSentinel(
  wrapped: Awaited<ReturnType<typeof SandboxManager.wrapWithSandboxArgv>>,
): { trustBundlePath: string; sentinel: string } {
  const command = wrapped.argv.join(" ");
  const trustBundlePath = sandboxTrustBundle(wrapped);
  const sentinel = command.match(/fake_value_[a-z0-9_-]+/)?.[0];
  if (!sentinel) throw new Error("SRT wrapper omitted credential sentinel");
  return { trustBundlePath, sentinel };
}

function tlsHandshakeRecord(payload: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header[0] = 0x16;
  header.writeUInt16BE(0x0303, 1);
  header.writeUInt16BE(payload.length, 3);
  return Buffer.concat([header, payload]);
}

function clientHelloWithAlpn(protocols: readonly string[]): Buffer {
  const protocolList = Buffer.concat(
    protocols.map((protocol) => {
      const value = Buffer.from(protocol, "latin1");
      return Buffer.concat([Buffer.from([value.length]), value]);
    }),
  );
  const alpnBody = Buffer.concat([
    Buffer.from([
      (protocolList.length >> 8) & 0xff,
      protocolList.length & 0xff,
    ]),
    protocolList,
  ]);
  const extension = Buffer.concat([
    Buffer.from([0, 16, (alpnBody.length >> 8) & 0xff, alpnBody.length & 0xff]),
    alpnBody,
  ]);
  const body = Buffer.concat([
    Buffer.from([0x03, 0x03]),
    Buffer.alloc(32),
    Buffer.from([0]),
    Buffer.from([0, 2, 0x13, 0x01]),
    Buffer.from([1, 0]),
    Buffer.from([(extension.length >> 8) & 0xff, extension.length & 0xff]),
    extension,
  ]);
  const header = Buffer.alloc(4);
  header[0] = 1;
  header.writeUIntBE(body.length, 1, 3);
  return Buffer.concat([header, body]);
}

async function throughProxy(targetPort: number): Promise<{
  status: number;
  body: string;
}>;
async function throughProxy(
  targetPort: number,
  headers: Readonly<Record<string, string>>,
): Promise<{ status: number; body: string }>;
async function throughProxy(
  targetPort: number,
  headers: Readonly<Record<string, string>> = {},
): Promise<{ status: number; body: string }> {
  const proxyPort = SandboxManager.getProxyPort();
  const token = SandboxManager.getProxyAuthToken();
  if (!proxyPort || !token) throw new Error("SRT proxy is unavailable");
  return new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port: proxyPort,
      method: "GET",
      path: `http://127.0.0.1:${targetPort}/probe`,
      headers: {
        host: `127.0.0.1:${targetPort}`,
        "proxy-authorization": `Basic ${Buffer.from(`srt:${token}`).toString("base64")}`,
        ...headers,
      },
    });
    let body = "";
    req.setTimeout(5_000, () => req.destroy(new Error("proxy timeout")));
    req.on("response", (response) => {
      response.setEncoding("utf8");
      response.on("data", (chunk) => (body += chunk));
      response.once("end", () =>
        resolve({ status: response.statusCode ?? 0, body }),
      );
    });
    req.once("error", reject);
    req.end();
  });
}

describe.sequential("ZSR exact loopback network policy", () => {
  const servers: Server[] = [];
  const certificateAuthorities: MitmCA[] = [];

  afterEach(async () => {
    await SandboxManager.reset().catch(() => undefined);
    await Promise.all(servers.splice(0).map(close));
    await Promise.all(certificateAuthorities.splice(0).map(disposeMitmCA));
  });

  it("parses fragmented ClientHello ALPN offers and rejects oversized records", () => {
    const hello = clientHelloWithAlpn(["h2", "http/1.1"]);
    const first = tlsHandshakeRecord(hello.subarray(0, 13));
    const second = tlsHandshakeRecord(hello.subarray(13));
    expect(parseClientHelloAlpn(first)).toBeNull();
    expect(parseClientHelloAlpn(Buffer.concat([first, second]))).toEqual([
      "h2",
      "http/1.1",
    ]);
    expect(() =>
      parseClientHelloAlpn(Buffer.from([0x16, 0x03, 0x03, 0x48, 0x01])),
    ).toThrow(/record length/i);
  });

  it("classifies an obvious non-TLS CONNECT prefix without waiting for three bytes", async () => {
    const socket = new PassThrough();
    try {
      const classified = peekForClientHello(socket, Buffer.alloc(0));
      socket.write("S");
      await expect(classified).resolves.toEqual({
        isTLS: false,
        head: Buffer.from("S"),
      });
    } finally {
      socket.destroy();
    }
  });

  it("keeps normal remote policy while allowing only leased loopback ports", async () => {
    const allowedServer = createServer((_request, response) =>
      response.end("allowed"),
    );
    const deniedServer = createServer((_request, response) =>
      response.end("must-not-reach"),
    );
    servers.push(allowedServer, deniedServer);
    const allowedPort = await listen(allowedServer);
    const deniedPort = await listen(deniedServer);

    await SandboxManager.initialize(
      {
        filesystem: {
          denyRead: [],
          allowRead: [],
          allowWrite: [],
          denyWrite: [],
          allowGitConfig: true,
          disableMandatoryWriteProtection: true,
        },
        network: {
          allowedDomains: ["*"],
          deniedDomains: ["169.254.169.254"],
          strictAllowlist: true,
          allowedLocalPorts: [allowedPort],
        },
      },
      undefined,
      false,
    );

    await expect(throughProxy(allowedPort)).resolves.toEqual({
      status: 200,
      body: "allowed",
    });
    const denied = await throughProxy(deniedPort);
    expect(denied.status).toBe(403);
    expect(denied.body).not.toContain("must-not-reach");
  });

  it("injects a masked credential only at its exact host and port", async () => {
    const realCredential = "zsr-real-credential-value";
    const seen: string[] = [];
    const intended = createServer((request, response) => {
      seen.push(`intended:${request.headers.authorization ?? ""}`);
      response.end("intended");
    });
    const sibling = createServer((request, response) => {
      seen.push(`sibling:${request.headers.authorization ?? ""}`);
      response.end("sibling");
    });
    servers.push(intended, sibling);
    const intendedPort = await listen(intended);
    const siblingPort = await listen(sibling);
    const previous = process.env.ZEROS_TEST_PROVIDER_KEY;
    process.env.ZEROS_TEST_PROVIDER_KEY = realCredential;
    try {
      await SandboxManager.initialize(
        {
          filesystem: {
            denyRead: [],
            allowRead: [],
            allowWrite: [],
            denyWrite: [],
            allowGitConfig: true,
            disableMandatoryWriteProtection: true,
          },
          network: {
            allowedDomains: ["*"],
            deniedDomains: [],
            strictAllowlist: true,
            allowedLocalPorts: [intendedPort, siblingPort],
          },
          credentials: {
            envVars: [
              {
                name: "ZEROS_TEST_PROVIDER_KEY",
                mode: "mask",
                injectHosts: [`127.0.0.1:${intendedPort}`],
                allowPlaintextInject: true,
              },
            ],
          },
        },
        undefined,
        false,
      );
      const wrapped = await SandboxManager.wrapWithSandboxArgv("/usr/bin/true");
      const sentinel = wrapped.argv
        .join(" ")
        .match(/fake_value_[a-z0-9_-]+/)?.[0];
      expect(sentinel).toBeTruthy();

      await expect(
        throughProxy(intendedPort, {
          authorization: `Bearer ${sentinel}`,
        }),
      ).resolves.toMatchObject({ status: 200 });
      await expect(
        throughProxy(siblingPort, {
          authorization: `Bearer ${sentinel}`,
        }),
      ).resolves.toMatchObject({ status: 200 });
      expect(seen).toEqual([
        `intended:Bearer ${realCredential}`,
        `sibling:Bearer ${sentinel}`,
      ]);
    } finally {
      if (previous === undefined) delete process.env.ZEROS_TEST_PROVIDER_KEY;
      else process.env.ZEROS_TEST_PROVIDER_KEY = previous;
    }
  });

  it("preserves HTTP/2 streaming, policy checks, credential injection, and trailers", async () => {
    const realCredential = "zsr-real-http2-credential";
    const upstreamCa = createMitmCA({});
    certificateAuthorities.push(upstreamCa);
    const leaf = mintLeafCert(upstreamCa, "127.0.0.1");
    const target = createHttp2SecureServer({
      allowHTTP1: true,
      cert: leaf.certPem,
      key: leaf.keyPem,
    });
    servers.push(target);

    const observed = new Promise<{
      authorization: string;
      body: string;
      httpVersion: string;
    }>((resolve, reject) => {
      target.on("stream", (stream, headers) => {
        let body = "";
        stream.setEncoding("utf8");
        stream.on("data", (chunk) => (body += chunk));
        stream.once("error", reject);
        stream.once("end", () => {
          resolve({
            authorization: String(headers.authorization ?? ""),
            body,
            httpVersion: "2.0",
          });
          stream.respond(
            { ":status": 200, "content-type": "text/plain" },
            { waitForTrailers: true },
          );
          stream.once("wantTrailers", () => {
            stream.sendTrailers({ "x-zsr-trailer": "forwarded" });
          });
          stream.end("h2-response");
        });
      });
    });
    const targetPort = await listen(target);
    const filteredUrls: string[] = [];
    const previous = process.env.ZEROS_TEST_PROVIDER_KEY;
    process.env.ZEROS_TEST_PROVIDER_KEY = realCredential;

    let tls: TLSSocket | undefined;
    let client: ReturnType<typeof connectHttp2> | undefined;
    try {
      await SandboxManager.initialize(
        {
          filesystem: {
            denyRead: [],
            allowRead: [],
            allowWrite: [],
            denyWrite: [],
            allowGitConfig: true,
            disableMandatoryWriteProtection: true,
          },
          network: {
            allowedDomains: ["*"],
            deniedDomains: [],
            strictAllowlist: true,
            allowedLocalPorts: [targetPort],
            tlsTerminate: {
              includeDomains: [`127.0.0.1:${targetPort}`],
              extraCaCertPaths: [upstreamCa.certPath],
            },
            filterRequest: async (request) => {
              filteredUrls.push(request.url);
              return { action: "allow" as const };
            },
          },
          credentials: {
            envVars: [
              {
                name: "ZEROS_TEST_PROVIDER_KEY",
                mode: "mask",
                injectHosts: [`127.0.0.1:${targetPort}`],
              },
            ],
          },
        },
        undefined,
        false,
      );
      const projection = sandboxTrustBundleAndSentinel(
        await SandboxManager.wrapWithSandboxArgv("/usr/bin/true"),
      );
      tls = await openTlsProxyTunnel({
        targetPort,
        trustBundlePath: projection.trustBundlePath,
        alpnProtocols: ["h2", "http/1.1"],
      });
      expect(tls.alpnProtocol).toBe("h2");

      client = connectHttp2(`https://127.0.0.1:${targetPort}`, {
        createConnection: () => tls!,
      });
      const response = await new Promise<{
        body: string;
        status: number;
        trailer: string;
      }>((resolve, reject) => {
        const req = client!.request({
          ":method": "POST",
          ":path": "/stream?mode=h2",
          authorization: `Bearer ${projection.sentinel}`,
          "content-type": "text/plain",
        });
        let body = "";
        let status = 0;
        let trailer = "";
        req.setEncoding("utf8");
        req.once("response", (headers) => {
          status = Number(headers[":status"] ?? 0);
        });
        req.once("trailers", (headers) => {
          trailer = String(headers["x-zsr-trailer"] ?? "");
        });
        req.on("data", (chunk) => (body += chunk));
        req.once("error", reject);
        req.once("end", () => resolve({ body, status, trailer }));
        req.write(`body:${projection.sentinel.slice(0, 7)}`);
        req.end(projection.sentinel.slice(7));
      });

      await expect(observed).resolves.toEqual({
        authorization: `Bearer ${realCredential}`,
        body: `body:${realCredential}`,
        httpVersion: "2.0",
      });
      expect(response).toEqual({
        body: "h2-response",
        status: 200,
        trailer: "forwarded",
      });
      expect(filteredUrls).toEqual([
        `https://127.0.0.1:${targetPort}/stream?mode=h2`,
      ]);
    } finally {
      client?.destroy();
      tls?.destroy();
      if (previous === undefined) delete process.env.ZEROS_TEST_PROVIDER_KEY;
      else process.env.ZEROS_TEST_PROVIDER_KEY = previous;
    }
  });

  it("does not hold a short HTTP/2 request frame while a bidirectional peer responds", async () => {
    const realCredential = "zsr-real-http2-bidi-credential";
    const upstreamCa = createMitmCA({});
    certificateAuthorities.push(upstreamCa);
    const leaf = mintLeafCert(upstreamCa, "127.0.0.1");
    const target = createHttp2SecureServer({
      allowHTTP1: true,
      cert: leaf.certPem,
      key: leaf.keyPem,
    });
    servers.push(target);

    const observed = new Promise<{ authorization: string; frame: string }>(
      (resolve, reject) => {
        target.on("stream", (stream, headers) => {
          stream.once("error", reject);
          stream.once("data", (chunk: Buffer) => {
            resolve({
              authorization: String(headers.authorization ?? ""),
              frame: chunk.toString("utf8"),
            });
            // Cursor's AgentService/Run is bidirectional: the server responds
            // after an initial protobuf frame while the request half remains
            // open for tool results. The proxy must not wait for request EOF.
            stream.respond({ ":status": 200, "content-type": "text/plain" });
            stream.end("bidi-ready");
          });
        });
      },
    );
    const targetPort = await listen(target);
    const previous = process.env.ZEROS_TEST_PROVIDER_KEY;
    process.env.ZEROS_TEST_PROVIDER_KEY = realCredential;

    let tls: TLSSocket | undefined;
    let client: ReturnType<typeof connectHttp2> | undefined;
    try {
      await SandboxManager.initialize(
        {
          filesystem: {
            denyRead: [],
            allowRead: [],
            allowWrite: [],
            denyWrite: [],
            allowGitConfig: true,
            disableMandatoryWriteProtection: true,
          },
          network: {
            allowedDomains: ["*"],
            deniedDomains: [],
            strictAllowlist: true,
            allowedLocalPorts: [targetPort],
            tlsTerminate: {
              includeDomains: [`127.0.0.1:${targetPort}`],
              extraCaCertPaths: [upstreamCa.certPath],
            },
            filterRequest: async () => ({ action: "allow" as const }),
          },
          credentials: {
            envVars: [
              {
                name: "ZEROS_TEST_PROVIDER_KEY",
                mode: "mask",
                injectHosts: [`127.0.0.1:${targetPort}`],
              },
            ],
          },
        },
        undefined,
        false,
      );
      const projection = sandboxTrustBundleAndSentinel(
        await SandboxManager.wrapWithSandboxArgv("/usr/bin/true"),
      );
      tls = await openTlsProxyTunnel({
        targetPort,
        trustBundlePath: projection.trustBundlePath,
        alpnProtocols: ["h2"],
      });
      client = connectHttp2(`https://127.0.0.1:${targetPort}`, {
        createConnection: () => tls!,
      });

      const req = client.request({
        ":method": "POST",
        ":path": "/bidirectional",
        authorization: `Bearer ${projection.sentinel}`,
        "content-type": "application/connect+proto",
      });
      const response = new Promise<{ status: number; body: string }>(
        (resolve, reject) => {
          let status = 0;
          let body = "";
          req.setEncoding("utf8");
          req.once("response", (headers) => {
            status = Number(headers[":status"] ?? 0);
          });
          req.on("data", (chunk) => (body += chunk));
          req.once("error", reject);
          req.once("end", () => resolve({ status, body }));
        },
      );
      req.write("cursor-bidi-frame");

      await expect(
        Promise.race([
          response,
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("bidirectional response timed out")),
              2_000,
            ),
          ),
        ]),
      ).resolves.toEqual({ status: 200, body: "bidi-ready" });
      await expect(observed).resolves.toEqual({
        authorization: `Bearer ${realCredential}`,
        frame: "cursor-bidi-frame",
      });
      req.close();
    } finally {
      client?.destroy();
      tls?.destroy();
      if (previous === undefined) delete process.env.ZEROS_TEST_PROVIDER_KEY;
      else process.env.ZEROS_TEST_PROVIDER_KEY = previous;
    }
  });

  it("bounds suffix matching work for adversarial credential prefixes", async () => {
    const prefixBytes = 4_096;
    const sentinel = Buffer.from(`${"a".repeat(prefixBytes)}b`);
    const input = Buffer.from(`${"a".repeat(prefixBytes - 1)}c`);
    const replacement = Buffer.alloc(sentinel.length, "x");
    const equalityChecks = vi.spyOn(Buffer.prototype, "equals");
    let output = Buffer.alloc(0);
    let comparisons = 0;
    try {
      const transform = createBodySubstitutionTransform([
        { sentinel, realValue: replacement },
      ]);
      const chunks: Buffer[] = [];
      transform.on("data", (chunk: Buffer) => chunks.push(chunk));
      const completed = new Promise<void>((resolve, reject) => {
        transform.once("end", resolve);
        transform.once("error", reject);
      });
      transform.end(input);
      await completed;
      output = Buffer.concat(chunks);
      comparisons = equalityChecks.mock.calls.length;
    } finally {
      equalityChecks.mockRestore();
    }

    expect(output).toEqual(input);
    expect(comparisons).toBeLessThan(64);
  });

  it("preserves HTTP/2 extended CONNECT as an opaque bidirectional stream", async () => {
    const realCredential = "zsr-real-h2-connect-credential";
    const upstreamCa = createMitmCA({});
    certificateAuthorities.push(upstreamCa);
    const leaf = mintLeafCert(upstreamCa, "127.0.0.1");
    const target = createHttp2SecureServer({
      cert: leaf.certPem,
      key: leaf.keyPem,
      settings: { enableConnectProtocol: true },
    });
    servers.push(target);

    const observedHeaders = new Promise<{
      protocol: string;
      authorization: string;
    }>((resolve, reject) => {
      target.on("stream", (stream, headers) => {
        stream.once("error", reject);
        resolve({
          protocol: String(headers[":protocol"] ?? ""),
          authorization: String(headers.authorization ?? ""),
        });
        stream.respond({ ":status": 200, "x-zsr-connect": "accepted" });
        stream.pipe(stream);
      });
    });
    const targetPort = await listen(target);
    const filterContexts: unknown[] = [];
    const previous = process.env.ZEROS_TEST_PROVIDER_KEY;
    process.env.ZEROS_TEST_PROVIDER_KEY = realCredential;

    let tls: TLSSocket | undefined;
    let client: ReturnType<typeof connectHttp2> | undefined;
    try {
      await SandboxManager.initialize(
        {
          filesystem: {
            denyRead: [],
            allowRead: [],
            allowWrite: [],
            denyWrite: [],
            allowGitConfig: true,
            disableMandatoryWriteProtection: true,
          },
          network: {
            allowedDomains: ["*"],
            deniedDomains: [],
            strictAllowlist: true,
            allowedLocalPorts: [targetPort],
            tlsTerminate: {
              includeDomains: [`127.0.0.1:${targetPort}`],
              extraCaCertPaths: [upstreamCa.certPath],
            },
            filterRequest: async (request, context) => {
              expect(request.method).toBe("CONNECT");
              filterContexts.push(context);
              return { action: "allow" as const };
            },
          },
          credentials: {
            envVars: [
              {
                name: "ZEROS_TEST_PROVIDER_KEY",
                mode: "mask",
                injectHosts: [`127.0.0.1:${targetPort}`],
              },
            ],
          },
        },
        undefined,
        false,
      );
      const projection = sandboxTrustBundleAndSentinel(
        await SandboxManager.wrapWithSandboxArgv("/usr/bin/true"),
      );
      tls = await openTlsProxyTunnel({
        targetPort,
        trustBundlePath: projection.trustBundlePath,
        alpnProtocols: ["h2"],
      });
      client = connectHttp2(`https://127.0.0.1:${targetPort}`, {
        createConnection: () => tls!,
      });
      await new Promise<void>((resolve, reject) => {
        const onSettings = (settings: { enableConnectProtocol?: boolean }) => {
          if (!settings.enableConnectProtocol) {
            reject(new Error("proxy omitted SETTINGS_ENABLE_CONNECT_PROTOCOL"));
            return;
          }
          resolve();
        };
        client!.once("remoteSettings", onSettings);
        client!.once("error", reject);
      });

      const response = await new Promise<{
        status: number;
        accepted: string;
        body: string;
      }>((resolve, reject) => {
        const stream = client!.request(
          {
            ":method": "CONNECT",
            ":protocol": "websocket",
            ":scheme": "https",
            ":authority": `127.0.0.1:${targetPort}`,
            ":path": "/opaque",
            authorization: `Bearer ${projection.sentinel}`,
          },
          { endStream: false },
        );
        let status = 0;
        let accepted = "";
        let body = "";
        stream.setEncoding("utf8");
        stream.once("response", (headers) => {
          status = Number(headers[":status"] ?? 0);
          accepted = String(headers["x-zsr-connect"] ?? "");
          // A sentinel-shaped application payload is opaque protocol data and
          // must not be rewritten after the CONNECT handshake.
          stream.end(`opaque:${projection.sentinel}`);
        });
        stream.on("data", (chunk) => (body += chunk));
        stream.once("error", reject);
        stream.once("end", () => resolve({ status, accepted, body }));
      });

      await expect(observedHeaders).resolves.toEqual({
        protocol: "websocket",
        authorization: `Bearer ${realCredential}`,
      });
      expect(response).toEqual({
        status: 200,
        accepted: "accepted",
        body: `opaque:${projection.sentinel}`,
      });
      expect(filterContexts).toEqual([
        {
          hasBody: false,
          body: null,
          httpVersion: "2.0",
          protocol: "websocket",
        },
      ]);
    } finally {
      client?.destroy();
      tls?.destroy();
      if (previous === undefined) delete process.env.ZEROS_TEST_PROVIDER_KEY;
      else process.env.ZEROS_TEST_PROVIDER_KEY = previous;
    }
  });

  it("preserves ordinary HTTP/1.1 HTTPS requests through the mixed TLS front end", async () => {
    const realCredential = "zsr-real-http1-credential";
    const upstreamCa = createMitmCA({});
    certificateAuthorities.push(upstreamCa);
    const leaf = mintLeafCert(upstreamCa, "127.0.0.1");
    type Observation = {
      authorization: string;
      body: string;
      httpVersion: string;
    };
    let resolveObserved!: (value: Observation) => void;
    let rejectObserved!: (reason?: unknown) => void;
    const observed = new Promise<Observation>((resolve, reject) => {
      resolveObserved = resolve;
      rejectObserved = reject;
    });
    const target = createHttp2SecureServer(
      { allowHTTP1: true, cert: leaf.certPem, key: leaf.keyPem },
      (request, response) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => (body += chunk));
        request.once("error", rejectObserved);
        request.once("end", () => {
          resolveObserved({
            authorization: request.headers.authorization ?? "",
            body,
            httpVersion: request.httpVersion,
          });
          response.writeHead(200, { "content-type": "text/plain" });
          response.end("h1-response");
        });
      },
    );
    servers.push(target);
    const targetPort = await listen(target);
    const previous = process.env.ZEROS_TEST_PROVIDER_KEY;
    process.env.ZEROS_TEST_PROVIDER_KEY = realCredential;
    let tls: TLSSocket | undefined;

    try {
      await SandboxManager.initialize(
        {
          filesystem: {
            denyRead: [],
            allowRead: [],
            allowWrite: [],
            denyWrite: [],
            allowGitConfig: true,
            disableMandatoryWriteProtection: true,
          },
          network: {
            allowedDomains: ["*"],
            deniedDomains: [],
            strictAllowlist: true,
            allowedLocalPorts: [targetPort],
            tlsTerminate: {
              includeDomains: [`127.0.0.1:${targetPort}`],
              extraCaCertPaths: [upstreamCa.certPath],
            },
          },
          credentials: {
            envVars: [
              {
                name: "ZEROS_TEST_PROVIDER_KEY",
                mode: "mask",
                injectHosts: [`127.0.0.1:${targetPort}`],
              },
            ],
          },
        },
        undefined,
        false,
      );
      const projection = sandboxTrustBundleAndSentinel(
        await SandboxManager.wrapWithSandboxArgv("/usr/bin/true"),
      );
      tls = await openTlsProxyTunnel({
        targetPort,
        trustBundlePath: projection.trustBundlePath,
        alpnProtocols: ["http/1.1"],
      });
      const response = readUntil(tls, Buffer.from("h1-response"));
      const body = `body:${projection.sentinel}`;
      tls.write(
        "POST /ordinary HTTP/1.1\r\n" +
          `Host: 127.0.0.1:${targetPort}\r\n` +
          "Connection: close\r\n" +
          `Content-Length: ${Buffer.byteLength(body)}\r\n` +
          `Authorization: Bearer ${projection.sentinel}\r\n\r\n` +
          body,
      );

      expect((await response).before.toString("latin1")).toMatch(
        /^HTTP\/1\.1 200 [\s\S]*h1-response$/,
      );
      await expect(observed).resolves.toEqual({
        authorization: `Bearer ${realCredential}`,
        body: `body:${realCredential}`,
        httpVersion: "1.1",
      });
    } finally {
      tls?.destroy();
      if (previous === undefined) delete process.env.ZEROS_TEST_PROVIDER_KEY;
      else process.env.ZEROS_TEST_PROVIDER_KEY = previous;
    }
  });

  it("mirrors an HTTP/1.1-only upstream ALPN result to clients", async () => {
    const upstreamCa = createMitmCA({});
    certificateAuthorities.push(upstreamCa);
    const leaf = mintLeafCert(upstreamCa, "127.0.0.1");
    const observedVersions: string[] = [];
    const target = createHttpsServer(
      { cert: leaf.certPem, key: leaf.keyPem },
      (incoming, response) => {
        observedVersions.push(incoming.httpVersion);
        response.end("h1-only-response");
      },
    );
    servers.push(target);
    const targetPort = await listen(target);
    let tls: TLSSocket | undefined;

    try {
      await SandboxManager.initialize(
        {
          filesystem: {
            denyRead: [],
            allowRead: [],
            allowWrite: [],
            denyWrite: [],
            allowGitConfig: true,
            disableMandatoryWriteProtection: true,
          },
          network: {
            allowedDomains: ["*"],
            deniedDomains: [],
            strictAllowlist: true,
            allowedLocalPorts: [targetPort],
            tlsTerminate: {
              includeDomains: [`127.0.0.1:${targetPort}`],
              extraCaCertPaths: [upstreamCa.certPath],
            },
          },
        },
        undefined,
        false,
      );
      const trustBundlePath = sandboxTrustBundle(
        await SandboxManager.wrapWithSandboxArgv("/usr/bin/true"),
      );
      tls = await openTlsProxyTunnel({
        targetPort,
        trustBundlePath,
        alpnProtocols: ["h2", "http/1.1"],
      });
      expect(tls.alpnProtocol).toBe("http/1.1");

      const response = readUntil(tls, Buffer.from("h1-only-response"));
      tls.write(
        "GET /alpn HTTP/1.1\r\n" +
          `Host: 127.0.0.1:${targetPort}\r\n` +
          "Connection: close\r\n\r\n",
      );
      expect((await response).before.toString("latin1")).toMatch(
        /^HTTP\/1\.1 200 [\s\S]*h1-only-response$/,
      );
      expect(observedVersions).toEqual(["1.1"]);
    } finally {
      tls?.destroy();
    }
  });

  it("substitutes a masked credential in HTTP/2 DATA without a content-length header", async () => {
    const realCredential = "zsr-real-http2-get-body-credential";
    const upstreamCa = createMitmCA({});
    certificateAuthorities.push(upstreamCa);
    const leaf = mintLeafCert(upstreamCa, "127.0.0.1");
    let resolveObserved!: (value: string) => void;
    let rejectObserved!: (reason?: unknown) => void;
    const observed = new Promise<string>((resolve, reject) => {
      resolveObserved = resolve;
      rejectObserved = reject;
    });
    let resolveFiltered!: (value: string) => void;
    let rejectFiltered!: (reason?: unknown) => void;
    const filtered = new Promise<string>((resolve, reject) => {
      resolveFiltered = resolve;
      rejectFiltered = reject;
    });
    const target = createHttp2SecureServer({
      cert: leaf.certPem,
      key: leaf.keyPem,
    });
    servers.push(target);
    target.on("stream", (stream) => {
      let body = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => (body += chunk));
      stream.once("error", rejectObserved);
      stream.once("end", () => {
        resolveObserved(body);
        stream.respond({ ":status": 200 });
        stream.end("ok");
      });
    });
    const targetPort = await listen(target);
    const previous = process.env.ZEROS_TEST_PROVIDER_KEY;
    process.env.ZEROS_TEST_PROVIDER_KEY = realCredential;
    let tls: TLSSocket | undefined;
    let client: ReturnType<typeof connectHttp2> | undefined;

    try {
      await SandboxManager.initialize(
        {
          filesystem: {
            denyRead: [],
            allowRead: [],
            allowWrite: [],
            denyWrite: [],
            allowGitConfig: true,
            disableMandatoryWriteProtection: true,
          },
          network: {
            allowedDomains: ["*"],
            deniedDomains: [],
            strictAllowlist: true,
            allowedLocalPorts: [targetPort],
            tlsTerminate: {
              includeDomains: [`127.0.0.1:${targetPort}`],
              extraCaCertPaths: [upstreamCa.certPath],
            },
            filterRequest: async (request, context) => {
              try {
                expect(request.method).toBe("GET");
                expect(request.body).toBeNull();
                expect(context.hasBody).toBe(true);
                if (!context.body) throw new Error("filter body is missing");
                resolveFiltered(await new Response(context.body).text());
                return { action: "allow" as const };
              } catch (error) {
                rejectFiltered(error);
                throw error;
              }
            },
          },
          credentials: {
            envVars: [
              {
                name: "ZEROS_TEST_PROVIDER_KEY",
                mode: "mask",
                injectHosts: [`127.0.0.1:${targetPort}`],
              },
            ],
          },
        },
        undefined,
        false,
      );
      const projection = sandboxTrustBundleAndSentinel(
        await SandboxManager.wrapWithSandboxArgv("/usr/bin/true"),
      );
      tls = await openTlsProxyTunnel({
        targetPort,
        trustBundlePath: projection.trustBundlePath,
        alpnProtocols: ["h2", "http/1.1"],
      });
      client = connectHttp2(`https://127.0.0.1:${targetPort}`, {
        createConnection: () => tls!,
      });
      await new Promise<void>((resolve, reject) => {
        const request = client!.request(
          { ":method": "GET", ":path": "/get-with-data" },
          { endStream: false },
        );
        request.on("data", () => undefined);
        request.once("end", resolve);
        request.once("error", reject);
        request.end(`body:${projection.sentinel}`);
      });
      await expect(filtered).resolves.toBe(`body:${projection.sentinel}`);
      await expect(observed).resolves.toBe(`body:${realCredential}`);
    } finally {
      client?.destroy();
      tls?.destroy();
      if (previous === undefined) delete process.env.ZEROS_TEST_PROVIDER_KEY;
      else process.env.ZEROS_TEST_PROVIDER_KEY = previous;
    }
  });

  it("preserves WebSocket upgrades while injecting only the handshake credential", async () => {
    const realCredential = "zsr-real-websocket-credential";
    const upstreamCa = createMitmCA({});
    certificateAuthorities.push(upstreamCa);
    const leaf = mintLeafCert(upstreamCa, "127.0.0.1");
    const target = createHttp2SecureServer(
      { allowHTTP1: true, cert: leaf.certPem, key: leaf.keyPem },
      (_request, response) => {
        response.writeHead(426);
        response.end();
      },
    );
    servers.push(target);
    const upgrades: Array<{ authorization: string; url: string }> = [];
    target.on("upgrade", (request, socket, head) => {
      upgrades.push({
        authorization: request.headers.authorization ?? "",
        url: request.url ?? "",
      });
      const key = request.headers["sec-websocket-key"] ?? "";
      const accept = createHash("sha1")
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Connection: Upgrade\r\n" +
          "Upgrade: websocket\r\n" +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      if (head.length > 0) socket.write(head);
      socket.pipe(socket);
    });
    const targetPort = await listen(target);
    const previous = process.env.ZEROS_TEST_PROVIDER_KEY;
    process.env.ZEROS_TEST_PROVIDER_KEY = realCredential;
    let tls: TLSSocket | undefined;

    try {
      await SandboxManager.initialize(
        {
          filesystem: {
            denyRead: [],
            allowRead: [],
            allowWrite: [],
            denyWrite: [],
            allowGitConfig: true,
            disableMandatoryWriteProtection: true,
          },
          network: {
            allowedDomains: ["*"],
            deniedDomains: [],
            strictAllowlist: true,
            allowedLocalPorts: [targetPort],
            tlsTerminate: {
              includeDomains: [`127.0.0.1:${targetPort}`],
              extraCaCertPaths: [upstreamCa.certPath],
            },
            filterRequest: async (request, context) => {
              expect(context).toMatchObject({
                hasBody: false,
                body: null,
                httpVersion: "1.1",
              });
              return request.url.endsWith("/denied")
                ? { action: "deny" as const, reason: "upgrade path denied" }
                : { action: "allow" as const };
            },
          },
          credentials: {
            envVars: [
              {
                name: "ZEROS_TEST_PROVIDER_KEY",
                mode: "mask",
                injectHosts: [`127.0.0.1:${targetPort}`],
              },
            ],
          },
        },
        undefined,
        false,
      );
      const projection = sandboxTrustBundleAndSentinel(
        await SandboxManager.wrapWithSandboxArgv("/usr/bin/true"),
      );
      tls = await openTlsProxyTunnel({
        targetPort,
        trustBundlePath: projection.trustBundlePath,
        alpnProtocols: ["http/1.1"],
      });
      const websocketKey = Buffer.from("zeros-websocket").toString("base64");
      tls.write(
        "GET /responses HTTP/1.1\r\n" +
          `Host: 127.0.0.1:${targetPort}\r\n` +
          "Connection: Upgrade\r\n" +
          "Upgrade: websocket\r\n" +
          `Sec-WebSocket-Key: ${websocketKey}\r\n` +
          "Sec-WebSocket-Version: 13\r\n" +
          `Authorization: Bearer ${projection.sentinel}\r\n\r\n`,
      );
      const handshake = await readUntil(tls, Buffer.from("\r\n\r\n"));
      expect(handshake.before.toString("latin1")).toMatch(
        /^HTTP\/1\.1 101 Switching Protocols/,
      );
      expect(handshake.after).toHaveLength(0);

      const echo = readUntil(tls, Buffer.from("zsr-websocket-echo"));
      tls.write("zsr-websocket-echo");
      await expect(echo).resolves.toMatchObject({ after: Buffer.alloc(0) });
      expect(upgrades).toEqual([
        {
          authorization: `Bearer ${realCredential}`,
          url: "/responses",
        },
      ]);

      tls.destroy();
      tls = await openTlsProxyTunnel({
        targetPort,
        trustBundlePath: projection.trustBundlePath,
        alpnProtocols: ["http/1.1"],
      });
      tls.write(
        "GET /denied HTTP/1.1\r\n" +
          `Host: 127.0.0.1:${targetPort}\r\n` +
          "Connection: Upgrade\r\n" +
          "Upgrade: websocket\r\n" +
          `Sec-WebSocket-Key: ${websocketKey}\r\n` +
          "Sec-WebSocket-Version: 13\r\n" +
          `Authorization: Bearer ${projection.sentinel}\r\n\r\n`,
      );
      const denied = await readUntil(tls, Buffer.from("\r\n\r\n"));
      expect(denied.before.toString("latin1")).toMatch(/^HTTP\/1\.1 403 /);
      expect(upgrades).toHaveLength(1);
    } finally {
      tls?.destroy();
      if (previous === undefined) delete process.env.ZEROS_TEST_PROVIDER_KEY;
      else process.env.ZEROS_TEST_PROVIDER_KEY = previous;
    }
  });

  it("does not mint a trusted leaf for client-controlled SNI", async () => {
    const upstreamCa = createMitmCA({});
    certificateAuthorities.push(upstreamCa);
    const leaf = mintLeafCert(upstreamCa, "127.0.0.1");
    const target = createHttp2SecureServer({
      allowHTTP1: true,
      cert: leaf.certPem,
      key: leaf.keyPem,
    });
    servers.push(target);
    const targetPort = await listen(target);
    const previous = process.env.ZEROS_TEST_PROVIDER_KEY;
    process.env.ZEROS_TEST_PROVIDER_KEY = "zsr-sni-test-credential";
    try {
      await SandboxManager.initialize(
        {
          filesystem: {
            denyRead: [],
            allowRead: [],
            allowWrite: [],
            denyWrite: [],
            allowGitConfig: true,
            disableMandatoryWriteProtection: true,
          },
          network: {
            allowedDomains: ["*"],
            deniedDomains: [],
            strictAllowlist: true,
            allowedLocalPorts: [targetPort],
            tlsTerminate: {
              includeDomains: [`127.0.0.1:${targetPort}`],
              extraCaCertPaths: [upstreamCa.certPath],
            },
          },
          credentials: {
            envVars: [
              {
                name: "ZEROS_TEST_PROVIDER_KEY",
                mode: "mask",
                injectHosts: [`127.0.0.1:${targetPort}`],
              },
            ],
          },
        },
        undefined,
        false,
      );
      const projection = sandboxTrustBundleAndSentinel(
        await SandboxManager.wrapWithSandboxArgv("/usr/bin/true"),
      );
      await expect(
        openTlsProxyTunnel({
          targetPort,
          trustBundlePath: projection.trustBundlePath,
          alpnProtocols: ["http/1.1"],
          servername: "client-controlled.invalid",
        }),
      ).rejects.toThrow(/hostname|alternative|certificate/i);
    } finally {
      if (previous === undefined) delete process.env.ZEROS_TEST_PROVIDER_KEY;
      else process.env.ZEROS_TEST_PROVIDER_KEY = previous;
    }
  });

  it("limits TLS termination to the credential authorities", async () => {
    const previous = process.env.ZEROS_TEST_PROVIDER_KEY;
    process.env.ZEROS_TEST_PROVIDER_KEY = "zsr-real-credential-value";
    try {
      await SandboxManager.initialize(
        {
          filesystem: {
            denyRead: [],
            allowRead: [],
            allowWrite: [],
            denyWrite: [],
            allowGitConfig: true,
            disableMandatoryWriteProtection: true,
          },
          network: {
            allowedDomains: ["*"],
            deniedDomains: [],
            strictAllowlist: true,
            tlsTerminate: {
              includeDomains: ["api.example.test:443"],
            },
          },
          credentials: {
            envVars: [
              {
                name: "ZEROS_TEST_PROVIDER_KEY",
                mode: "mask",
                injectHosts: ["api.example.test:443"],
              },
            ],
          },
        },
        undefined,
        false,
      );
      const wrapped = await SandboxManager.wrapWithSandboxArgv("/usr/bin/true");
      expect(wrapped.argv.join(" ")).toContain("fake_value_");
      expect(wrapped.argv.join(" ")).toContain("NODE_EXTRA_CA_CERTS");
      expect(wrapped.argv.join(" ")).toContain("NPM_CONFIG_CAFILE");
      expect(wrapped.argv.join(" ")).toContain(
        "GRPC_DEFAULT_SSL_ROOTS_FILE_PATH",
      );
    } finally {
      if (previous === undefined) delete process.env.ZEROS_TEST_PROVIDER_KEY;
      else process.env.ZEROS_TEST_PROVIDER_KEY = previous;
    }
  });

  it("rejects a masked HTTPS destination outside the termination include set", async () => {
    const previous = process.env.ZEROS_TEST_PROVIDER_KEY;
    process.env.ZEROS_TEST_PROVIDER_KEY = "zsr-real-credential-value";
    try {
      const parsed = SandboxRuntimeConfigSchema.safeParse({
        filesystem: {
          denyRead: [],
          allowRead: [],
          allowWrite: [],
          denyWrite: [],
        },
        network: {
          allowedDomains: ["*"],
          deniedDomains: [],
          strictAllowlist: true,
          tlsTerminate: {
            includeDomains: ["other.example.test:443"],
          },
        },
        credentials: {
          envVars: [
            {
              name: "ZEROS_TEST_PROVIDER_KEY",
              mode: "mask",
              injectHosts: ["api.example.test:443"],
            },
          ],
        },
      });
      expect(parsed.success).toBe(false);
      if (parsed.success) throw new Error("expected invalid credential route");
      expect(parsed.error.message).toMatch(/not covered.*includeDomains/i);
    } finally {
      if (previous === undefined) delete process.env.ZEROS_TEST_PROVIDER_KEY;
      else process.env.ZEROS_TEST_PROVIDER_KEY = previous;
    }
  });
});
