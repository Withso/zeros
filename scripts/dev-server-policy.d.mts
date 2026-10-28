import type { IncomingMessage, ServerResponse } from "node:http";

// Keep the shared plugin structural: marketing has a standalone Vite install
// whose private environment types need not match the desktop's install.
type DevelopmentServer = {
  config: { root: string; publicDir: string | false };
  middlewares: { use(handler: (request: IncomingMessage, response: ServerResponse, next: () => void) => void): unknown };
};

export const PRIVATE_DEV_FILES: string[];
export function isPrivateDevPath(file: string): boolean;
export function developmentServerOptions(allow: string[], env?: Record<string, string | undefined>): {
  host: string;
  allowedHosts: string[];
  fs: { strict: true; allow: string[]; deny: string[] };
};
export function developmentFileBoundary(allow: readonly string[]): {
  name: string;
  apply: "serve";
  enforce: "pre";
  load(id: string): undefined;
  configureServer(server: DevelopmentServer): void;
};
