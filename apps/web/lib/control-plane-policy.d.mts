export declare function allowedControlPlaneRoute(
  method: string,
  pathname: string,
): boolean;
export declare function validMutationOrigin(request: Request): boolean;
export declare function cancelUnusedResponseBody(
  response: Response,
): Promise<void>;
export declare function readBoundedBody(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; body: ArrayBuffer } | { ok: false }>;
