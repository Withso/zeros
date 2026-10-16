import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import {
  SIMULATOR_HID_PROTOCOL,
  SIMULATOR_HID_SOURCE,
  readableInterface,
} from "../build-simulator-hid.mjs";

const root = resolve(import.meta.dirname, "../..");

describe("the simulator input helper's protocol", () => {
  it("is the same in the helper, in Zeros and in the build that checks the helper", () => {
    const swift = readFileSync(resolve(root, SIMULATOR_HID_SOURCE), "utf8");
    const client = readFileSync(resolve(root, "apps/desktop/electron/devices/simulator-hid.ts"), "utf8");
    expect(/^let protocolVersion = (\d+)$/m.exec(swift)?.[1]).toBe(String(SIMULATOR_HID_PROTOCOL));
    expect(/^export const SIMULATOR_HID_PROTOCOL = (\d+);$/m.exec(client)?.[1]).toBe(
      String(SIMULATOR_HID_PROTOCOL),
    );
  });
});

const HEADER =
  "// swift-compiler-version: Apple Swift version 6.3.2 effective-5.10 (swiftlang-6.3.2.1.108 clang-2100.1.1.101)\n" +
  "// swift-module-flags: -target arm64-apple-macos12.0 -module-name FBSimulatorControl\n" +
  "import FBControlCore\n" +
  "import IOSurface\n";

describe("readableInterface", () => {
  it("drops the module's name where a type of that name would hide the module", () => {
    const source =
      HEADER +
      "@objc public class FBSimulatorControl : ObjectiveC.NSObject {}\n" +
      "public protocol AsyncAccessibilityCommands : FBSimulatorControl.AsyncAccessibilityOperations {\n" +
      "  func element(forKey key: FBControlCore.FBAXSearchableKey) async throws -> FBSimulatorControl.FBAccessibilityElement\n" +
      "  func control() -> FBSimulatorControl.FBSimulatorControl\n" +
      "  func surface() -> IOSurface.IOSurface\n" +
      "}\n";

    expect(readableInterface(source, "FBSimulatorControl")).toBe(
      HEADER +
        "@objc public class FBSimulatorControl : ObjectiveC.NSObject {}\n" +
        "public protocol AsyncAccessibilityCommands : AsyncAccessibilityOperations {\n" +
        "  func element(forKey key: FBControlCore.FBAXSearchableKey) async throws -> FBAccessibilityElement\n" +
        "  func control() -> FBSimulatorControl\n" +
        "  func surface() -> IOSurface\n" +
        "}\n",
    );
  });

  it("keeps a module's own qualifiers when no type shares its name", () => {
    const source =
      "// swift-module-flags: -module-name FBControlCore\n" +
      "public func run() -> FBControlCore.FBFuture {}\n" +
      "public func surface() -> IOSurface.IOSurface {}\n";

    expect(readableInterface(source, "FBControlCore")).toBe(
      "// swift-module-flags: -module-name FBControlCore\n" +
        "public func run() -> FBControlCore.FBFuture {}\n" +
        "public func surface() -> IOSurface {}\n",
    );
  });
});
