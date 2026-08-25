export function workosControlPlaneOrigin(env) {
  const raw = env.CONTROL_PLANE_URL || "https://api.zeros.build";
  const url = new URL(raw);
  const loopback =
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]" ||
      url.hostname === "localhost");
  if (
    (url.protocol !== "https:" && !loopback) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("CONTROL_PLANE_URL must be an HTTPS or loopback origin");
  }
  return url.origin;
}

export function fetchWorkOSRailway(
  env,
  pathAndSearch,
  init = {},
  fetchImpl = fetch,
) {
  if (!pathAndSearch.startsWith("/") || pathAndSearch.startsWith("//")) {
    throw new TypeError("Railway WorkOS path must be absolute");
  }
  return fetchImpl(`${workosControlPlaneOrigin(env)}${pathAndSearch}`, {
    ...init,
    redirect: "manual",
  });
}
