const WEB_STATIC_EXCLUSIONS = [
  "/assets/*",
  "/agents/*",
  "/schemas/*",
  "/ZEROS-logo-name.svg",
  "/zeros-logo.png",
  "/zeros-logo.svg",
  "/zeros-wordmark.svg",
  "/LICENSE.txt",
  "/THIRD-PARTY-LICENSES.txt",
  "/THIRD-PARTY-NOTICES.md",
];

/** Build the Pages Functions invocation policy for one isolated surface. */
export function pagesFunctionRoutes(surface) {
  if (surface !== "app" && surface !== "ops") {
    throw new TypeError("Pages surface must be app or ops");
  }
  return {
    version: 1,
    include: ["/*"],
    // Ops must route every path through its strict middleware allowlist. The
    // public web projects can bypass Functions for immutable public assets.
    exclude: surface === "ops" ? [] : [...WEB_STATIC_EXCLUSIONS],
  };
}
