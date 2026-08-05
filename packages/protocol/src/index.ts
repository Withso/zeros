// @zeros/protocol — shared Zeros bridge protocol.
// Single source of truth for contracts shared by the desktop renderer,
// Electron main/preload, and engine. See subpath exports in package.json
// for granular imports (./messages, ./agent-events, ./version, ./schemas).

export * from "./agent-events";
export * from "./messages";
export * from "./model-context";
export * from "./version";
export * from "./schemas";
export * from "./github-auth";
