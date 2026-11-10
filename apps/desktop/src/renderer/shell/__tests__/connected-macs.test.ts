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
  });
});
