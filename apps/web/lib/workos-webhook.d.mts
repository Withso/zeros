export interface WorkOSWebhookEnv {
  WORKOS_WEBHOOK_SECRET?: string;
  AUTH_BROKER_SECRET?: string;
  CONTROL_PLANE_URL?: string;
}

export function handleWorkOSWebhook(
  request: Request,
  env: WorkOSWebhookEnv,
  options?: {
    now?: () => number;
    fetch?: typeof fetch;
  },
): Promise<Response>;
