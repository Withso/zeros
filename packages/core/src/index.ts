// @zeros/core — shared Zeros bridge protocol.
// Single source of truth for the wire contract between the engine and
// the desktop renderer and engine. See subpath exports in package.json
// for granular imports (./messages, ./agent-events, ./version, ./schemas).

export * from "./agent-events";
export * from "./messages";
export * from "./model-context";
export * from "./version";
export * from "./schemas";
export * from "./github-auth";
