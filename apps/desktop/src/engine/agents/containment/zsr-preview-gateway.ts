import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import type { Duplex } from "node:stream";

const CAPABILITY_QUERY = "__zsr_cap";
const MAX_URL_BYTES = 16_384;
const ADMISSION_TTL_MS = 60_000;
const MAX_PENDING_ADMISSIONS = 8;
const MIN_EXTERNAL_ADMISSION_LIFETIME_MS = 5_000;
const COOKIE_AUTHORIZATION_TTL_MS = 60 * 60_000;

export interface ZsrPreviewTarget {
  readonly targetHost: "127.0.0.1" | "::1";
  readonly targetPort: number;
  readonly displayPort: number;
}

export interface PreviewNavigation {
  readonly url: string;
  readonly admissionUrl: string;
  /** Absolute deadline for renewing the browser's volatile admission. */
  readonly expiresAt: number;
}

export interface BoundaryPreviewGateway {
  navigation(): Promise<PreviewNavigation>;
  close(): Promise<void>;
}

export interface BoundaryPreviewGatewayFactory {
  open(target: ZsrPreviewTarget): Promise<BoundaryPreviewGateway>;
}

export interface ZsrPreviewExposure {
  /** Token-free URL safe to retain in renderer tab state. */
  readonly publicBaseUrl: string;
  /** Provider-scoped bearer URL used only for the one-use first navigation. */
  readonly admissionBaseUrl: string;
  /** Absolute expiry of the provider bearer. */
  readonly expiresAt: number;
}

export interface ZsrPreviewGatewayOptions {
  readonly listenHost?: "127.0.0.1" | "0.0.0.0";
  readonly listenPort?: number;
  readonly exposure?: ZsrPreviewExposure;
  readonly onClose?: () => void | Promise<void>;
}

interface NormalizedExposure extends ZsrPreviewExposure {
  readonly credentialQuery: ReadonlyMap<string, readonly string[]>;
}

function validPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65_535;
}

function secretMatches(left: string, right: string): boolean {
  if (!left || !right) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookieValue(header: string | undefined, name: string): string {
  for (const field of (header ?? "").split(";")) {
    const separator = field.indexOf("=");
    if (separator < 0) continue;
    if (field.slice(0, separator).trim() === name) {
      return field.slice(separator + 1).trim();
    }
  }
  return "";
}

function withoutCookie(header: string | undefined, name: string): string {
  return (header ?? "")
    .split(";")
    .map((field) => field.trim())
    .filter(Boolean)
    .filter((field) => {
      const separator = field.indexOf("=");
      return separator < 0 || field.slice(0, separator).trim() !== name;
    })
    .join("; ");
}

function normalizedExposure(input: ZsrPreviewExposure): NormalizedExposure {
  let publicUrl: URL;
  let admissionUrl: URL;
  try {
    publicUrl = new URL(input.publicBaseUrl);
    admissionUrl = new URL(input.admissionBaseUrl);
  } catch {
    throw new Error("preview exposure URLs are invalid");
  }
  if (
    publicUrl.protocol !== "https:" ||
    admissionUrl.protocol !== "https:" ||
    publicUrl.username ||
    publicUrl.password ||
    admissionUrl.username ||
    admissionUrl.password ||
    publicUrl.hash ||
    admissionUrl.hash ||
    publicUrl.pathname !== "/" ||
    admissionUrl.pathname !== "/" ||
    publicUrl.href !== admissionUrl.href ||
    admissionUrl.searchParams.has(CAPABILITY_QUERY) ||
    !Number.isSafeInteger(input.expiresAt) ||
    Number(input.expiresAt) <= 0
  ) {
    throw new Error("preview exposure URLs have an unsupported contract");
  }
  const credentialQuery = new Map<string, readonly string[]>();
  for (const key of new Set(admissionUrl.searchParams.keys())) {
    credentialQuery.set(key, admissionUrl.searchParams.getAll(key));
  }
  return {
    publicBaseUrl: publicUrl.toString(),
    admissionBaseUrl: admissionUrl.toString(),
    expiresAt: Number(input.expiresAt),
    credentialQuery,
  };
}

function targetHeaders(
  request: IncomingMessage,
  target: ZsrPreviewTarget,
  cookieName: string,
  upgrade: boolean,
): IncomingHttpHeaders {
  const headers: IncomingHttpHeaders = { ...request.headers };
  delete headers["proxy-authorization"];
  delete headers["proxy-authenticate"];
  delete headers["keep-alive"];
  delete headers["transfer-encoding"];
  if (!upgrade) {
    delete headers.connection;
    delete headers.upgrade;
  }
  const appCookies = withoutCookie(request.headers.cookie, cookieName);
  if (appCookies) headers.cookie = appCookies;
  else delete headers.cookie;
  headers.host = `localhost:${target.displayPort}`;

  // The target observes the same virtual localhost origin the program asked
  // for, not the generation-private proxy port. This preserves ordinary dev
  // server Host/Origin checks without disclosing the real endpoint.
  if (request.headers.origin) {
    headers.origin = `http://localhost:${target.displayPort}`;
  }
  if (request.headers.referer) {
    try {
      const referer = new URL(request.headers.referer);
      referer.hostname = "localhost";
      referer.port = String(target.displayPort);
      headers.referer = referer.toString();
    } catch {
      delete headers.referer;
    }
  }
  return headers;
}

/** One capability-authenticated, generation-local HTTP/WebSocket façade.
 *
 * A dedicated random loopback port keeps absolute asset URLs, SPA routing,
 * cookies, WebSockets, and HMR indistinguishable from a normal localhost
 * server. The real ZSR listener remains unadvertised; the first navigation
 * presents a 256-bit query capability and receives an HttpOnly strict cookie.
 */
export class ZsrPreviewGateway implements BoundaryPreviewGateway {
  private readonly server: HttpServer;
  private readonly sockets = new Set<Duplex>();
  private cookieTokenBytes = randomBytes(32);
  private cookieToken = this.cookieTokenBytes.toString("base64url");
  private readonly admissionTokens = new Map<
    string,
    { bytes: Buffer; expiresAt: number }
  >();
  private readonly cookieName = `zsr_preview_${randomBytes(8).toString("hex")}`;
  private listeningPort = 0;
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private exposure: NormalizedExposure | null;
  private closeHookCalled = false;

  private constructor(
    private readonly target: ZsrPreviewTarget,
    private readonly options: ZsrPreviewGatewayOptions,
  ) {
    this.exposure = options.exposure
      ? normalizedExposure(options.exposure)
      : null;
    this.server = createServer((request, response) => {
      void this.handleHttp(request, response).catch(() => {
        if (response.headersSent) response.destroy();
        else {
          response.writeHead(502, {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store",
          });
          response.end("Preview server unavailable.");
        }
      });
    });
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });
    this.server.on("upgrade", (request, socket, head) => {
      this.handleUpgrade(request, socket, head);
    });
  }

  static async open(
    target: ZsrPreviewTarget,
    options: ZsrPreviewGatewayOptions = {},
  ): Promise<ZsrPreviewGateway> {
    if (target.targetHost !== "127.0.0.1" && target.targetHost !== "::1") {
      throw new Error("preview target must be exact loopback");
    }
    if (!validPort(target.targetPort) || !validPort(target.displayPort)) {
      throw new Error("preview target ports are invalid");
    }
    const listenHost = options.listenHost ?? "127.0.0.1";
    const listenPort = options.listenPort ?? 0;
    if (
      (listenHost !== "127.0.0.1" && listenHost !== "0.0.0.0") ||
      (listenPort !== 0 && !validPort(listenPort)) ||
      (listenHost === "0.0.0.0" && (!options.exposure || listenPort === 0))
    ) {
      throw new Error("preview gateway listener is invalid");
    }
    const gateway = new ZsrPreviewGateway(target, options);
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          gateway.server.removeListener("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          gateway.server.removeListener("error", onError);
          resolve();
        };
        gateway.server.once("error", onError);
        gateway.server.once("listening", onListening);
        gateway.server.listen(listenPort, listenHost);
      });
    } catch (error) {
      await gateway.close().catch(() => undefined);
      throw error;
    }
    const address = gateway.server.address();
    if (!address || typeof address === "string") {
      await gateway.close();
      throw new Error("preview gateway did not bind TCP");
    }
    gateway.listeningPort = address.port;
    return gateway;
  }

  get baseUrl(): string {
    if (this.exposure) return this.exposure.publicBaseUrl;
    if (!this.listeningPort) throw new Error("preview gateway is not ready");
    return `http://127.0.0.1:${this.listeningPort}/`;
  }

  get capabilityUrl(): string {
    if (this.closed) throw new Error("preview gateway is closed");
    if (
      this.exposure?.expiresAt !== undefined &&
      this.exposure.expiresAt - Date.now() < MIN_EXTERNAL_ADMISSION_LIFETIME_MS
    ) {
      throw new Error("preview admission expired");
    }
    this.purgeAdmissionTokens();
    while (this.admissionTokens.size >= MAX_PENDING_ADMISSIONS) {
      const oldest = this.admissionTokens.keys().next().value as
        | string
        | undefined;
      if (!oldest) break;
      this.admissionTokens.get(oldest)?.bytes.fill(0);
      this.admissionTokens.delete(oldest);
    }
    const bytes = randomBytes(32);
    const token = bytes.toString("base64url");
    this.admissionTokens.set(token, {
      bytes,
      expiresAt: Date.now() + ADMISSION_TTL_MS,
    });
    const url = new URL(
      this.exposure?.admissionBaseUrl ?? this.baseUrl,
    );
    url.searchParams.set(CAPABILITY_QUERY, token);
    return url.toString();
  }

  setExposure(exposure: ZsrPreviewExposure): void {
    if (this.closed) throw new Error("preview gateway is closed");
    const normalized = normalizedExposure(exposure);
    if (
      this.exposure &&
      this.exposure.publicBaseUrl !== normalized.publicBaseUrl
    ) {
      this.cookieTokenBytes.fill(0);
      this.cookieTokenBytes = randomBytes(32);
      this.cookieToken = this.cookieTokenBytes.toString("base64url");
      for (const state of this.admissionTokens.values()) state.bytes.fill(0);
      this.admissionTokens.clear();
    }
    this.exposure = normalized;
  }

  async navigation(): Promise<PreviewNavigation> {
    const url = this.baseUrl;
    const admissionUrl = this.capabilityUrl;
    const expiresAt = Math.min(
      Date.now() + COOKIE_AUTHORIZATION_TTL_MS,
      this.exposure?.expiresAt ?? Number.MAX_SAFE_INTEGER,
    );
    return { url, admissionUrl, expiresAt };
  }

  private parseUrl(request: IncomingMessage): URL | null {
    const raw = request.url ?? "/";
    if (Buffer.byteLength(raw, "utf8") > MAX_URL_BYTES) return null;
    try {
      return new URL(raw, this.baseUrl);
    } catch {
      return null;
    }
  }

  private purgeAdmissionTokens(): void {
    const now = Date.now();
    for (const [token, state] of this.admissionTokens) {
      if (state.expiresAt > now) continue;
      state.bytes.fill(0);
      this.admissionTokens.delete(token);
    }
  }

  private consumeAdmissionToken(value: string): boolean {
    this.purgeAdmissionTokens();
    for (const [token, state] of this.admissionTokens) {
      if (!secretMatches(value, token)) continue;
      state.bytes.fill(0);
      this.admissionTokens.delete(token);
      return true;
    }
    return false;
  }

  private cookieAuthorized(request: IncomingMessage): boolean {
    return secretMatches(
      cookieValue(request.headers.cookie, this.cookieName),
      this.cookieToken,
    );
  }

  /** SameSite=None is required because the browser pane is a cross-site
   * iframe. Fetch Metadata then restores the CSRF boundary: only the one-use
   * admission navigation may arrive cross-site; cookie-backed app traffic is
   * same-origin (or a direct user navigation with no Fetch Metadata header). */
  private browserContextAuthorized(request: IncomingMessage): boolean {
    const fetchSite = request.headers["sec-fetch-site"];
    if (
      (Array.isArray(fetchSite) ? fetchSite[0] : fetchSite) === "cross-site"
    ) {
      return false;
    }
    const origin = request.headers.origin;
    const value = Array.isArray(origin) ? origin[0] : origin;
    if (!value) return true;
    try {
      return new URL(value).origin === new URL(this.baseUrl).origin;
    } catch {
      return false;
    }
  }

  private setCapabilityCookie(response: ServerResponse): void {
    const remainingSeconds = this.exposure?.expiresAt
      ? Math.max(1, Math.floor((this.exposure.expiresAt - Date.now()) / 1_000))
      : COOKIE_AUTHORIZATION_TTL_MS / 1_000;
    response.setHeader(
      "Set-Cookie",
      `${this.cookieName}=${this.cookieToken}; HttpOnly; Secure; SameSite=None; Partitioned; Path=/; Max-Age=${Math.min(COOKIE_AUTHORIZATION_TTL_MS / 1_000, remainingSeconds)}`,
    );
  }

  private sanitizedTargetPath(url: URL): string {
    url.searchParams.delete(CAPABILITY_QUERY);
    for (const [key, credentials] of this.exposure?.credentialQuery ?? []) {
      const retained = url.searchParams
        .getAll(key)
        .filter((value) => !credentials.includes(value));
      url.searchParams.delete(key);
      for (const value of retained) url.searchParams.append(key, value);
    }
    const value = `${url.pathname}${url.search}`;
    return value || "/";
  }

  private sendAdmissionBootstrap(response: ServerResponse, url: URL): void {
    this.setCapabilityCookie(response);
    const body =
      "<!doctype html><meta charset=utf-8>" +
      "<title>Opening preview…</title>";
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
      Refresh: `0; url=${this.sanitizedTargetPath(url)}`,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy":
        "default-src 'none'; base-uri 'none'; frame-ancestors *",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(body);
  }

  private async handleHttp(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (this.closed) {
      response.writeHead(410, { "Cache-Control": "no-store" });
      response.end();
      return;
    }
    const url = this.parseUrl(request);
    const suppliedAdmission = url?.searchParams.get(CAPABILITY_QUERY) ?? "";
    const admitted = suppliedAdmission
      ? this.consumeAdmissionToken(suppliedAdmission)
      : false;
    if (
      !url ||
      (!admitted &&
        (!this.cookieAuthorized(request) ||
          !this.browserContextAuthorized(request)))
    ) {
      response.writeHead(403, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end("Preview capability required.");
      return;
    }
    if (admitted) {
      this.sendAdmissionBootstrap(response, url);
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const upstream = httpRequest(
        {
          host: this.target.targetHost,
          port: this.target.targetPort,
          method: request.method,
          path: this.sanitizedTargetPath(url),
          headers: targetHeaders(request, this.target, this.cookieName, false),
        },
        (upstreamResponse) => {
          const headers = { ...upstreamResponse.headers };
          if (typeof headers.location === "string") {
            try {
              const location = new URL(
                headers.location,
                `http://localhost:${this.target.displayPort}`,
              );
              if (
                location.hostname === "localhost" ||
                location.hostname === "127.0.0.1" ||
                location.hostname === "::1"
              ) {
                headers.location = `${this.baseUrl.replace(/\/$/, "")}${location.pathname}${location.search}${location.hash}`;
              }
            } catch {
              delete headers.location;
            }
          }
          response.writeHead(
            upstreamResponse.statusCode ?? 502,
            upstreamResponse.statusMessage,
            headers,
          );
          upstreamResponse.pipe(response);
          upstreamResponse.once("end", resolve);
          upstreamResponse.once("error", reject);
        },
      );
      upstream.once("error", reject);
      request.once("aborted", () => upstream.destroy());
      request.pipe(upstream);
    });
  }

  private handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void {
    if (this.closed) {
      socket.destroy();
      return;
    }
    const url = this.parseUrl(request);
    const suppliedAdmission = url?.searchParams.get(CAPABILITY_QUERY) ?? "";
    const admitted = suppliedAdmission
      ? this.consumeAdmissionToken(suppliedAdmission)
      : false;
    if (
      !url ||
      (!admitted &&
        (!this.cookieAuthorized(request) ||
          !this.browserContextAuthorized(request)))
    ) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    const upstream = httpRequest({
      host: this.target.targetHost,
      port: this.target.targetPort,
      method: request.method,
      path: this.sanitizedTargetPath(url),
      headers: targetHeaders(request, this.target, this.cookieName, true),
    });
    socket.once("close", () => upstream.destroy());
    upstream.once("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
      const status = upstreamResponse.statusCode ?? 101;
      const reason = upstreamResponse.statusMessage ?? "Switching Protocols";
      const lines = [`HTTP/1.1 ${status} ${reason}`];
      for (let index = 0; index < upstreamResponse.rawHeaders.length; index += 2) {
        lines.push(
          `${upstreamResponse.rawHeaders[index]}: ${upstreamResponse.rawHeaders[index + 1]}`,
        );
      }
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (upstreamHead.length > 0) socket.write(upstreamHead);
      if (head.length > 0) upstreamSocket.write(head);
      upstreamSocket.once("error", () => socket.destroy());
      socket.once("error", () => upstreamSocket.destroy());
      upstreamSocket.once("close", () => socket.destroy());
      socket.once("close", () => upstreamSocket.destroy());
      upstreamSocket.pipe(socket).pipe(upstreamSocket);
    });
    upstream.once("response", (upstreamResponse) => {
      socket.end(
        `HTTP/1.1 ${upstreamResponse.statusCode ?? 502} ${upstreamResponse.statusMessage ?? "Bad Gateway"}\r\nConnection: close\r\n\r\n`,
      );
      upstreamResponse.resume();
    });
    upstream.once("error", () => socket.destroy());
    upstream.end();
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.cookieToken = "";
    this.cookieTokenBytes.fill(0);
    for (const state of this.admissionTokens.values()) state.bytes.fill(0);
    this.admissionTokens.clear();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.closePromise = new Promise<void>((resolve, reject) => {
      if (!this.server.listening) {
        resolve();
        return;
      }
      this.server.close((error) => (error ? reject(error) : resolve()));
    }).finally(async () => {
      if (this.closeHookCalled) return;
      this.closeHookCalled = true;
      await this.options.onClose?.();
    });
    return this.closePromise;
  }
}

export const localPreviewGatewayFactory: BoundaryPreviewGatewayFactory = {
  open: (target) => ZsrPreviewGateway.open(target),
};
