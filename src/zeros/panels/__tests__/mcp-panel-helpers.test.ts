import { describe, it, expect } from "vitest";

import {
  MCP_SECRET_SENTINEL,
  disabledToolsOf,
  draftError,
  draftFromServer,
  endpointSummary,
  isEnabled,
  kvToMap,
  mapToKV,
  newHeaderSecretFromDraft,
  newSecretsFromDraft,
  readRawServers,
  serverFromDraft,
  transportOf,
  withToggled,
  withToolDisabled,
  type Draft,
  type RawServer,
} from "../mcp-panel-helpers";

describe("disabledToolsOf / withToolDisabled (Cursor 40-cap allowlist)", () => {
  it("reads disabled_tools, tolerating absent / non-array / non-strings", () => {
    expect(disabledToolsOf({})).toEqual([]);
    expect(disabledToolsOf({ disabled_tools: ["a", "b"] })).toEqual(["a", "b"]);
    expect(disabledToolsOf({ disabled_tools: "nope" })).toEqual([]);
    expect(disabledToolsOf({ disabled_tools: ["a", 7] })).toEqual(["a"]);
  });
  it("disables (adds) then enables (removes, dropping the empty key)", () => {
    const servers: RawServer[] = [{ name: "fabric", transport: "http", url: "https://f/mcp", auth: "oauth" }];
    const off = withToolDisabled(servers, 0, "search", true);
    expect(off[0]!.disabled_tools).toEqual(["search"]);
    const back = withToolDisabled(off, 0, "search", false);
    expect("disabled_tools" in back[0]!).toBe(false);
  });
  it("never duplicates and never mutates the input", () => {
    const servers: RawServer[] = [
      { name: "x", transport: "http", url: "https://x/mcp", auth: "oauth", disabled_tools: ["a"] },
    ];
    const out = withToolDisabled(servers, 0, "a", true); // already disabled
    expect(out[0]!.disabled_tools).toEqual(["a"]);
    expect(servers[0]!.disabled_tools).toEqual(["a"]);
  });
});

const stdioDraft = (over: Partial<Draft> = {}): Draft => ({
  name: "ctx7",
  description: "",
  transport: "stdio",
  command: "npx",
  argsText: "-y\n@upstash/context7-mcp",
  url: "",
  env: [],
  headers: [],
  auth: "none",
  headerName: "Authorization",
  headerSecret: "",
  oauthClientId: "",
  ...over,
});

const httpDraft = (over: Partial<Draft> = {}): Draft => ({
  name: "example",
  description: "",
  transport: "http",
  command: "",
  argsText: "",
  url: "https://mcp.example.com/mcp",
  env: [],
  headers: [],
  auth: "none",
  headerName: "Authorization",
  headerSecret: "",
  oauthClientId: "",
  ...over,
});

describe("readRawServers", () => {
  it("returns [] for missing / non-array mcp.servers", () => {
    expect(readRawServers(undefined)).toEqual([]);
    expect(readRawServers({})).toEqual([]);
    expect(readRawServers({ mcp: {} })).toEqual([]);
    expect(readRawServers({ mcp: { servers: "nope" } })).toEqual([]);
  });

  it("keeps object entries and drops scalars/arrays (can't be a server row)", () => {
    const out = readRawServers({
      mcp: { servers: [{ name: "a", transport: "stdio", command: "x" }, "bad", 7, ["nested"], null] },
    });
    expect(out).toEqual([{ name: "a", transport: "stdio", command: "x" }]);
  });
});

describe("transportOf / endpointSummary / isEnabled", () => {
  it("defaults transport to stdio unless explicitly http", () => {
    expect(transportOf({ transport: "http" })).toBe("http");
    expect(transportOf({ transport: "stdio" })).toBe("stdio");
    expect(transportOf({})).toBe("stdio");
    expect(transportOf({ transport: "weird" })).toBe("stdio");
  });

  it("summarizes the endpoint per transport", () => {
    expect(endpointSummary({ transport: "http", url: "https://x/mcp" })).toBe("https://x/mcp");
    expect(endpointSummary({ transport: "stdio", command: "npx", args: ["-y", "pkg"] })).toBe("npx -y pkg");
    expect(endpointSummary({ transport: "stdio", command: "node" })).toBe("node");
    expect(endpointSummary({ transport: "http" })).toBe("(no url)");
  });

  it("treats absent/true as enabled, only false as disabled", () => {
    expect(isEnabled({})).toBe(true);
    expect(isEnabled({ enabled: true })).toBe(true);
    expect(isEnabled({ enabled: false })).toBe(false);
  });
});

describe("kvToMap / mapToKV", () => {
  it("round-trips a map, trims keys, drops blank keys", () => {
    const rows = mapToKV({ A: "1", B: "2" });
    expect(rows.map((r) => [r.key, r.value])).toEqual([["A", "1"], ["B", "2"]]);
    expect(kvToMap(rows)).toEqual({ A: "1", B: "2" });
    expect(kvToMap([{ id: 1, key: "  K ", value: "v" }, { id: 2, key: "", value: "x" }])).toEqual({ K: "v" });
  });

  it("mapToKV ignores non-objects", () => {
    expect(mapToKV(undefined)).toEqual([]);
    expect(mapToKV("nope")).toEqual([]);
    expect(mapToKV(["a"])).toEqual([]);
  });
});

describe("serverFromDraft", () => {
  it("builds a stdio server, splitting args by line and trimming", () => {
    const s = serverFromDraft(stdioDraft({ argsText: " -y \n @upstash/context7-mcp \n\n" }), null);
    expect(s).toEqual({
      name: "ctx7",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@upstash/context7-mcp"],
    });
  });

  it("omits empty args/env/headers so the TOML stays tidy", () => {
    expect(serverFromDraft(stdioDraft({ argsText: "   ", env: [] }), null)).toEqual({
      name: "ctx7",
      transport: "stdio",
      command: "npx",
    });
    expect(serverFromDraft(httpDraft({ headers: [] }), null)).toEqual({
      name: "example",
      transport: "http",
      url: "https://mcp.example.com/mcp",
    });
  });

  it("includes env (stdio) and headers (http) when present", () => {
    expect(serverFromDraft(stdioDraft({ env: [{ id: 1, key: "TOKEN", value: "ref" }] }), null)).toMatchObject({
      env: { TOKEN: "ref" },
    });
    expect(
      serverFromDraft(httpDraft({ headers: [{ id: 1, key: "Authorization", value: "Bearer x" }] }), null),
    ).toMatchObject({ headers: { Authorization: "Bearer x" } });
  });

  it("carries enabled:false forward from the edited entry (toggle lives on the row)", () => {
    const prior: RawServer = { name: "ctx7", transport: "stdio", command: "old", enabled: false };
    expect(serverFromDraft(stdioDraft(), prior)).toMatchObject({ enabled: false });
    // enabled:true / absent prior → no enabled key written
    expect("enabled" in serverFromDraft(stdioDraft(), { enabled: true })).toBe(false);
    expect("enabled" in serverFromDraft(stdioDraft(), null)).toBe(false);
  });

  it("round-trips a server through draftFromServer → serverFromDraft", () => {
    const server: RawServer = {
      name: "ctx7",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@upstash/context7-mcp"],
      env: { TOKEN: "ref" },
    };
    expect(serverFromDraft(draftFromServer(server), server)).toEqual(server);
  });

  it("carries disabled_tools and unknown keys forward from the prior entry (an edit never resets them)", () => {
    const prior: RawServer = {
      name: "fabric",
      transport: "http",
      url: "https://fabric/mcp",
      auth: "oauth",
      disabled_tools: ["search", "delete"],
      future_key: { nested: true }, // hand-written / forward-version key
      enabled: false,
    };
    const edited = serverFromDraft(
      { ...draftFromServer(prior), description: "now described" },
      prior,
    );
    expect(edited.disabled_tools).toEqual(["search", "delete"]);
    expect(edited.future_key).toEqual({ nested: true });
    expect(edited.enabled).toBe(false);
    expect(edited.description).toBe("now described");
    // A fresh add (no prior) writes neither key.
    expect("disabled_tools" in serverFromDraft(stdioDraft(), null)).toBe(false);
    expect("future_key" in serverFromDraft(stdioDraft(), null)).toBe(false);
  });

  it("round-trips a description (UI-only field), omitting it when blank", () => {
    const server: RawServer = {
      name: "ctx7",
      description: "Docs lookup for agents",
      transport: "stdio",
      command: "npx",
    };
    expect(draftFromServer(server).description).toBe("Docs lookup for agents");
    expect(serverFromDraft(draftFromServer(server), server)).toEqual(server);
    // Blank / whitespace description → no key written (tidy TOML).
    expect(
      "description" in serverFromDraft(stdioDraft({ description: "  " }), null),
    ).toBe(false);
  });
});

describe("draftError", () => {
  const taken = new Set<string>(["existing"]);
  it("requires a name", () => {
    expect(draftError(stdioDraft({ name: "  " }), taken)).toMatch(/name is required/i);
  });
  it("rejects a name already taken by another server", () => {
    expect(draftError(stdioDraft({ name: "existing" }), taken)).toMatch(/already named/i);
  });
  it("requires a command for stdio and a valid URL for http", () => {
    expect(draftError(stdioDraft({ command: "" }), taken)).toMatch(/command is required/i);
    expect(draftError(httpDraft({ url: "" }), taken)).toMatch(/url is required/i);
    expect(draftError(httpDraft({ url: "ftp://x" }), taken)).toMatch(/http/i);
  });
  it("passes a well-formed stdio + http draft", () => {
    expect(draftError(stdioDraft(), taken)).toBeNull();
    expect(draftError(httpDraft(), taken)).toBeNull();
  });
});

describe("withToggled", () => {
  const servers: RawServer[] = [
    { name: "a", transport: "stdio", command: "x" },
    { name: "b", transport: "http", url: "https://b/mcp", enabled: false },
  ];

  it("disabling sets enabled:false on the target only", () => {
    const out = withToggled(servers, 0, false);
    expect(out[0]).toEqual({ name: "a", transport: "stdio", command: "x", enabled: false });
    expect(out[1]).toBe(servers[1]); // untouched entries kept by reference
  });

  it("enabling deletes the enabled key (absent === enabled keeps the file clean)", () => {
    const out = withToggled(servers, 1, true);
    expect("enabled" in out[1]!).toBe(false);
    expect(out[1]).toEqual({ name: "b", transport: "http", url: "https://b/mcp" });
  });

  it("does not mutate the input array or entries", () => {
    withToggled(servers, 0, false);
    expect(servers[0]).toEqual({ name: "a", transport: "stdio", command: "x" });
  });
});

describe("Keychain secret env handling", () => {
  it("draftFromServer marks a sentinel'd env value secret + masks it", () => {
    const d = draftFromServer({
      name: "gh",
      transport: "stdio",
      command: "npx",
      env: { GITHUB_TOKEN: MCP_SECRET_SENTINEL, LOG: "debug" },
    });
    const tok = d.env.find((kv) => kv.key === "GITHUB_TOKEN")!;
    const log = d.env.find((kv) => kv.key === "LOG")!;
    expect(tok).toMatchObject({ secret: true, value: "" }); // masked; real value stays in Keychain
    expect(log.secret).toBeFalsy();
    expect(log.value).toBe("debug");
  });

  it("serverFromDraft writes the SENTINEL for a secret row (never the real value)", () => {
    const server = serverFromDraft(
      stdioDraft({
        env: [
          { id: 1, key: "GITHUB_TOKEN", value: "ghp_000000000000000000000000000000000000", secret: true },
          { id: 2, key: "LOG", value: "debug" },
        ],
      }),
      null,
    );
    // The real value is NOT in the settings object — only the sentinel.
    expect((server as { env: Record<string, string> }).env).toEqual({
      GITHUB_TOKEN: MCP_SECRET_SENTINEL,
      LOG: "debug",
    });
  });

  it("newSecretsFromDraft returns only freshly-typed secrets (stdio); skips masked/plain/http", () => {
    expect(
      newSecretsFromDraft(
        stdioDraft({
          env: [
            { id: 1, key: "NEW", value: "fresh", secret: true }, // typed → store
            { id: 2, key: "KEPT", value: "", secret: true }, // masked/edited → leave Keychain as-is
            { id: 3, key: "PLAIN", value: "x" }, // not secret
          ],
        }),
      ),
    ).toEqual([{ name: "NEW", value: "fresh" }]);
    // http never carries secrets here.
    expect(newSecretsFromDraft(httpDraft({ headers: [{ id: 1, key: "Authorization", value: "Bearer x" }] }))).toEqual([]);
  });

  it("round-trips a stored secret untouched when not re-entered (draft → server keeps the sentinel)", () => {
    const server: RawServer = { name: "gh", transport: "stdio", command: "npx", env: { TOKEN: MCP_SECRET_SENTINEL } };
    const back = serverFromDraft(draftFromServer(server), server);
    expect((back as { env: Record<string, string> }).env).toEqual({ TOKEN: MCP_SECRET_SENTINEL });
    expect(newSecretsFromDraft(draftFromServer(server))).toEqual([]); // nothing to re-store
  });
});

describe('auth:"header" (gateway-brokered static header)', () => {
  it("serverFromDraft writes auth+header_name but NEVER the secret value", () => {
    const s = serverFromDraft(
      httpDraft({ auth: "header", headerName: "Authorization", headerSecret: "Bearer sk-EXAMPLE0000000000000000" }),
      null,
    );
    expect(s).toEqual({
      name: "example",
      transport: "http",
      url: "https://mcp.example.com/mcp",
      auth: "header",
      header_name: "Authorization",
    });
    expect(JSON.stringify(s)).not.toContain("sk-EXAMPLE0000000000000000"); // the value is nowhere in the file
  });

  it("defaults a blank header name to Authorization", () => {
    const s = serverFromDraft(httpDraft({ auth: "header", headerName: "  " }), null) as { header_name: string };
    expect(s.header_name).toBe("Authorization");
  });

  it("draftFromServer reads auth+header_name, never a stored secret", () => {
    const d = draftFromServer({
      name: "x",
      transport: "http",
      url: "https://x/mcp",
      auth: "header",
      header_name: "X-Api-Key",
    });
    expect(d.auth).toBe("header");
    expect(d.headerName).toBe("X-Api-Key");
    expect(d.headerSecret).toBe(""); // write-only; the value isn't in settings
  });

  it("newHeaderSecretFromDraft returns the typed value (for the vault), else null", () => {
    expect(newHeaderSecretFromDraft(httpDraft({ auth: "header", headerSecret: "Bearer t" }))).toEqual({
      url: "https://mcp.example.com/mcp",
      headerName: "Authorization",
      value: "Bearer t",
    });
    expect(newHeaderSecretFromDraft(httpDraft({ auth: "header", headerSecret: "" }))).toBeNull(); // not re-entered
    expect(newHeaderSecretFromDraft(httpDraft({ auth: "oauth" }))).toBeNull();
    expect(newHeaderSecretFromDraft(stdioDraft())).toBeNull();
  });
});
