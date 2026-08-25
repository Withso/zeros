export function handleWorkOSDesktopRevocationRequest(
  request: Request,
  env: {
    AUTH_PROVIDER?: string;
    CONTROL_PLANE_URL?: string;
  },
  options?: { fetch?: typeof fetch },
): Promise<Response>;
