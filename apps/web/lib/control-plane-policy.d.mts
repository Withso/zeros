export declare function allowedControlPlaneRoute(
  method: string,
  pathname: string,
): boolean;
export declare function allowedOpsControlPlaneRoute(
  method: string,
  pathname: string,
): boolean;
export declare function acceptedControlPlaneResponseType(
  pathname: string,
  contentType: string,
): "json" | "sse" | null;
export declare function validMutationOrigin(request: Request): boolean;
export declare function cancelUnusedResponseBody(
  response: Response,
): Promise<void>;
export declare function jsonContentTypeOrCancel(
  response: Response,
): Promise<string | null>;
export declare function readBoundedBody(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; body: ArrayBuffer } | { ok: false }>;
export declare function readBoundedResponseBody(
  response: Response,
  maxBytes: number,
): Promise<{ ok: true; body: ArrayBuffer } | { ok: false }>;
