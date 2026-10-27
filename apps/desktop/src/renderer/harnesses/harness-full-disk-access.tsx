import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { FullDiskAccessStatus } from "../../../shared/full-disk-access";
import { FullDiskAccessRow } from "../features/settings/full-disk-access-row";
import { SettingsGroup } from "../features/settings/settings-ui";

const params = new URLSearchParams(location.search);
const calls: { command: string; args: unknown }[] = [];
let status: FullDiskAccessStatus = params.has("unsupported")
  ? "unsupported"
  : "denied";
let holdNext = false;
let release: (() => void) | undefined;
const fixture = {
  calls: () => calls,
  status: (value: FullDiskAccessStatus) => {
    status = value;
  },
  hold: () => {
    holdNext = true;
  },
  pending: () => !!release,
  release: () => {
    release?.();
    release = undefined;
  },
  active: (_value: boolean) => {},
  visibility: (value: "visible" | "hidden") => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  },
};
declare global {
  interface Window {
    __fullDiskAccessFixture: typeof fixture;
  }
}
window.__fullDiskAccessFixture = fixture;
if (!params.has("browser")) {
  window.__ZEROS_NATIVE__ = {
    localDevelopment: true,
    async invoke<T>(
      command: string,
      args?: Record<string, unknown>,
    ): Promise<T> {
      calls.push({ command, args });
      if (command !== "full_disk_access_status") return undefined as T;
      const snapshot = {
        status,
        appName: "Zeros Local — example",
        canRevealApp: status !== "unsupported",
      };
      if (holdNext) {
        holdNext = false;
        await new Promise<void>((done) => {
          release = done;
        });
      }
      return snapshot as T;
    },
    on: () => () => {},
  };
}

function Harness() {
  const [active, setActive] = useState(true);
  fixture.active = setActive;
  return (
    <main className="bg-bg1 text-fg2 min-h-screen p-8">
      <section hidden={!active}>
        <SettingsGroup title="Privacy">
          <FullDiskAccessRow surfaceActive={active} />
        </SettingsGroup>
      </section>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Harness />);
