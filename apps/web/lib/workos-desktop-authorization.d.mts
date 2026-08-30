export interface WorkOSDesktopAuthorizationEnv {
  AUTH_PROVIDER?: string;
  ZEROS_DEPLOY_ENV?: "alpha" | "beta" | "production";
  CONTROL_PLANE_URL?: string;
}

export function renderWorkOSDesktopAuthorizationPage(
  request: Request,
  env: WorkOSDesktopAuthorizationEnv,
): Response;
export function beginWorkOSDesktopAuthorization(
  request: Request,
  env: WorkOSDesktopAuthorizationEnv,
  options?: { fetch?: typeof fetch },
): Promise<Response>;
export function renderWorkOSDesktopCallback(
  request: Request,
  env: WorkOSDesktopAuthorizationEnv,
): Response;
