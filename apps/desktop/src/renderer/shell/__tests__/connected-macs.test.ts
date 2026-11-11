import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "../../shared/ui/primitives";
import { ConnectedMacs, formatExpiresIn, type ConnectedMac } from "../conversation/connected-macs";

const now = Date.parse("2026-11-10T12:00:00Z");
const macs: ConnectedMac[] = [
  { deviceId: "d1", name: "Alex's MacBook Pro", thisMac: true, state: "available", reachable: true },
  { deviceId: "d2", name: "Studio", thisMac: false, state: "connected", expiresAt: now + 4 * 3600_000 + 60_000, reachable: true },
  { deviceId: "d3", name: "Old Mini", thisMac: false, state: "active", reachable: false },
  { deviceId: "d4", name: "Spare", thisMac: false, state: "available", reachable: true },
];
const text = (html: string) => html.replace(/<[^>]+>/g, "\n").replaceAll("&#x27;", "'").split("\n").map(line => line.trim()).filter(Boolean);
const render = (props: Partial<Parameters<typeof ConnectedMacs>[0]> = {}) =>
  renderToStaticMarkup(createElement(TooltipProvider, { children: createElement(ConnectedMacs, { macs, now, onConnect: () => {}, onDisconnect: () => {}, ...props }) }));

describe("Connected Macs", () => {
  it("lists this person's Macs with This Mac, their state and one action each", () => {
    // Connect is issued by that Mac itself, so only This Mac offers it.
    expect(text(render())).toEqual(["Connected Macs", "Alex's MacBook Pro", "This Mac", "Not connected", "Connect",
      "Studio", "Connected · expires in 4 h", "Disconnect", "Old Mini", "Active · offline", "Disconnect", "Spare", "Not connected"]);
  });

  it("puts a sync switch under each connected Mac (12.z): This Mac's status dot, path and menu; another Mac's switch is what that Mac wants", () => {
    const connected: ConnectedMac[] = [
      { deviceId: "d1", name: "Alex's MacBook Pro", thisMac: true, state: "connected", reachable: true },
      { deviceId: "d2", name: "Studio", thisMac: false, state: "connected", reachable: true, syncing: true, syncWanted: true },
      { deviceId: "d3", name: "Old Mini", thisMac: false, state: "active", reachable: false, syncWanted: false },
      { deviceId: "d4", name: "Spare", thisMac: false, state: "available", reachable: true },
    ];
    const handlers = { busy: false, onEnable: () => {}, onStop: () => {}, onChoose: () => {}, onOpenTerminal: () => {}, onReveal: () => {}, onCopyPath: () => {} };
    const html = (status: Parameters<typeof ConnectedMacs>[0]["sync"] extends infer S ? S extends { status: infer T } ? T : never : never, list = connected) =>
      render({ macs: list, now, sync: { ...handlers, status }, onSetWanted: () => {} });
    const switches = (markup: string) => [...markup.matchAll(/<button[^>]*role="switch"[^>]*>/g)].map(match => ({
      name: /aria-label="([^"]*)"/.exec(match[0])?.[1]?.replaceAll("&#x27;", "'"), checked: /aria-checked="true"/.test(match[0]), disabled: / disabled=""/.test(match[0]) }));
    // Off: This Mac's switch only, no status or path; the other connected Macs show theirs; an unconnected Mac none.
    const off = html(null);
    expect(switches(off)).toEqual([
      { name: "Sync to a local directory on Alex's MacBook Pro", checked: false, disabled: false },
      { name: "Sync to a local directory on Studio", checked: true, disabled: false },
      { name: "Sync to a local directory on Old Mini", checked: false, disabled: false },
    ]);
    expect(text(off)).toContain("Syncing");
    expect(off).not.toContain("data-sync-path");
    // On: the status line with its dot, then This Mac's folder and its menu.
    const folder = "/Users/alex/zeros/cloud-sync/zeros/w-19";
    for (const [status, words, dot] of [
      [{ workspaceId: "w", state: "in_sync", problems: 0, folder }, "In sync", "bg-green-primary"],
      [{ workspaceId: "w", state: "syncing", files: 12, problems: 0, folder }, "Syncing (12 files)", "bg-fg3"],
      [{ workspaceId: "w", state: "paused", problems: 0, folder }, "Paused (workspace asleep)", "bg-fg3"],
      [{ workspaceId: "w", state: "error", reason: "too_many_bytes", problems: 0, folder }, "Error (more than 5 GB)", "bg-red-primary"],
    ] as const) {
      const markup = html(status);
      expect(switches(markup)[0]).toMatchObject({ checked: true });
      expect(text(markup)).toEqual(expect.arrayContaining([words, "~/zeros/cloud-sync/zeros/w-19"]));
      expect(markup).toMatch(new RegExp(`data-sync-dot="[a-z_]+"[^>]*class="[^"]*${dot}`));
      expect(markup).toContain('aria-label="Sync folder actions"');
    }
    // A control plane without 12.z: only This Mac's switch is live.
    const older = html(null, connected.map(mac => { const { syncWanted: _, ...rest } = mac; return rest; }));
    expect(switches(older).map(item => item.disabled)).toEqual([false, true, true]);
    // This Mac not connected yet: no switch until it connects.
    expect(switches(html(null, [{ ...connected[0]!, state: "available" }]))).toEqual([]);
  });

  it("disables only the Mac whose change is being sent, and says when there is none", () => {
    const html = render({ busyDeviceId: "d2" });
    expect(html).toContain('aria-label="Disconnect Studio"');
    expect(html.match(/disabled=""/g)).toHaveLength(1);
    expect(text(render({ macs: [] }))).toEqual(["Connected Macs", "No Macs signed in to this account."]);
  });

  it("formats the time left in minutes under an hour and hours otherwise", () => {
    expect([formatExpiresIn(now + 30_000, now), formatExpiresIn(now + 45 * 60_000, now), formatExpiresIn(now + 12 * 3600_000, now), formatExpiresIn(now - 1, now)])
      .toEqual(["expires in 1 min", "expires in 45 min", "expires in 12 h", "expiring"]);
  });
});

describe("Connected Macs mapping", () => {
  it("marks This Mac by device id and maps active, connected and available from the wire", async () => {
    const { toConnectedMac } = await import("../conversation/use-workspace-macs");
    const base = { deviceId: "d1", name: "Studio", reachable: true };
    expect(toConnectedMac({ ...base, connected: true, active: true, expiresAt: null }, "d1")).toEqual({ ...base, thisMac: true, state: "active" });
    expect(toConnectedMac({ ...base, connected: true, active: false, expiresAt: "2026-11-10T16:00:00.000Z" }, "other"))
      .toEqual({ ...base, thisMac: false, state: "connected", expiresAt: Date.parse("2026-11-10T16:00:00.000Z") });
    expect(toConnectedMac({ ...base, connected: false, active: false, expiresAt: null }, null)).toMatchObject({ state: "available", thisMac: false });
    // Order 3's syncing flag, absent from older control planes.
    expect(toConnectedMac({ ...base, connected: true, active: false, expiresAt: null, syncing: true }, null)).toMatchObject({ syncing: true });
    expect(toConnectedMac({ ...base, connected: true, active: false, expiresAt: null, syncing: false }, null)).not.toHaveProperty("syncing");
    // 12.z: syncWanted only from a control plane that has it (false is kept: it is an answer).
    expect(toConnectedMac({ ...base, connected: true, active: false, expiresAt: null, syncWanted: false }, null)).toMatchObject({ syncWanted: false });
    expect(toConnectedMac({ ...base, connected: true, active: false, expiresAt: null }, null)).not.toHaveProperty("syncWanted");
  });
});
