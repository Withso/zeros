import { providerJson } from "./provider-http.mjs";

export function devBoatClient(config, signal) {
  return (method, route, options = {}) => providerJson("Boat Dev", `https://boat.dev/api/v1${route}`, {
    method, signal, timeoutMs: options.timeoutMs ?? 65_000,
    headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json", ...options.headers },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}
