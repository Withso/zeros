import { CloudPreviewWebSocketRelay } from "./preview-websocket-relay.js";
import { CLOUD_RUNTIME_SERVICE_PROTOCOL, runtimeServiceToken, type DatabaseCloudRuntimeServiceAccess } from "./runtime-services.js";

export function createCloudRuntimeServiceRelay(service: Pick<DatabaseCloudRuntimeServiceAccess, "recognizes" | "resolve" | "revalidate">) {
  return new CloudPreviewWebSocketRelay({
    recognizes: request => service.recognizes(request),
    resolve: request => service.resolve(request),
    revalidate: (request, grant) => service.revalidate(request, grant),
    authorizeUpgrade: request => runtimeServiceToken(request.headers) ? {
      protocols: request.headers.has("sec-websocket-protocol") ? [CLOUD_RUNTIME_SERVICE_PROTOCOL] : [],
    } : null,
  });
}
