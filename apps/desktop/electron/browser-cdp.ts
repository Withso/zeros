export interface BrowserCdpRequest {
  method: string;
  params: Record<string, unknown>;
}

const MAX_CDP_REQUEST_BYTES = 128 * 1024;

export function parseBrowserCdpRequest(value: unknown): BrowserCdpRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("CDP request must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.method !== "string" ||
    !/^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/.test(record.method)
  ) {
    throw new Error("CDP method must use the Domain.method form.");
  }
  const params = record.params ?? {};
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("CDP parameters must be an object.");
  }
  if (
    Buffer.byteLength(JSON.stringify({ method: record.method, params })) >
    MAX_CDP_REQUEST_BYTES
  ) {
    throw new Error("CDP request is too large.");
  }
  return {
    method: record.method,
    params: params as Record<string, unknown>,
  };
}
