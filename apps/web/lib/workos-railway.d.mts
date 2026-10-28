export function workosControlPlaneOrigin(env: { CONTROL_PLANE_URL?: string }): string;
export function fetchWorkOSRailway(env: { CONTROL_PLANE_URL?: string }, pathAndSearch: string, init?: RequestInit, fetchImpl?: typeof fetch): Promise<Response>;
