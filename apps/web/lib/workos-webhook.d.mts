export interface WorkOSWebhookEnv {
  AUTH_PROVIDER?: string;
  CONTROL_PLANE_URL?: string;
}

export function handleWorkOSWebhook(
  request: Request,
  env: WorkOSWebhookEnv,
  options?: { fetch?: typeof fetch },
): Promise<Response>;
