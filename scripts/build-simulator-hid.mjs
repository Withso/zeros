#!/usr/bin/env node
// Build zeros-simulator-hid into AXe's staged folder.
//
// The helper (apps/desktop/native/simulator-hid/main.swift) keeps one
// process and one HID connection per iOS simulator, so the user's input
// reaches a device in about a millisecond instead of the second each AXe
// command takes to start. It links the idb frameworks AXe ships and loads
// them from the `Frameworks` folder beside it, so it is built into that
// folder: `pnpm stage:axe` builds it with AXe, and `pnpm build:simulator-hid`
// rebuilds it into the staged `binaries/axe` after the Swift source changes.
//
// AXe's frameworks describe their Swift API in textual interfaces written by
// the Swift compiler AXe was built with. Another compiler reads them back
// with two fixes, made to private copies used only for compiling (the
// originals stay untouched, so their signatures hold):
//   - where a module declares a type with its own name (the
//     FBSimulatorControl class), that type hides the module, so
//     `FBSimulatorControl.FBSimulatorSet` can't be read; inside the module's
//     own interface the bare name means the same type. `IOSurface.IOSurface`
//     becomes `IOSurface` for the same reason;
//   - the interfaces import CoreSimulator, a private Apple framework with no
//     module of its own, for a few class names, so a module declaring just
//     those classes stands in for it.
// The binary links nothing from those stand-ins: dyld loads the real
// frameworks at run time.

import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const filename = fileURLToPath(import.meta.url);

export const SIMULATOR_HID_SOURCE = "apps/desktop/native/simulator-hid/main.swift";
export const SIMULATOR_HID_BINARY = "zeros-simulator-hid";
// Keep in sync with `protocolVersion` in main.swift and
// SIMULATOR_HID_PROTOCOL in apps/desktop/electron/devices/simulator-hid.ts.
export const SIMULATOR_HID_PROTOCOL = 2;

/** The frameworks the helper compiles against, all from AXe's release. */
const COMPILE_FRAMEWORKS = ["FBControlCore", "FBSimulatorControl", "XCTestBootstrap"];
/** Matches the frameworks' own deployment target. */
const TARGET = "arm64-apple-macos12.0";
const CORE_SIMULATOR_CLASSES = ["SimDevice", "SimDeviceSet", "SimDeviceType", "SimRuntime"];

/** `moduleName`'s textual interface as another Swift compiler can read it;
 * see the header. */
export function readableInterface(source, moduleName) {
  let readable = source.replaceAll("IOSurface.IOSurface", "IOSurface");
  const ownType = new RegExp(`\\b(?:class|struct|enum|protocol|actor)\\s+${moduleName}\\b`);
  if (ownType.test(readable)) {
    readable = readable.replace(new RegExp(`\\b${moduleName}\\.(?=[A-Za-z_])`, "g"), "");
  }
  return readable;
}

function interfaces(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const file = join(directory, entry);
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) files.push(...interfaces(file));
    else if (entry.endsWith(".swiftinterface")) files.push(file);
  }
  return files;
}

function writeCoreSimulatorModule(directory) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "module.modulemap"),
    'module CoreSimulator [system] {\n  header "CoreSimulator.h"\n  export *\n}\n',
  );
  writeFileSync(
    join(directory, "CoreSimulator.h"),
    [
      "#import <Foundation/Foundation.h>",
      ...CORE_SIMULATOR_CLASSES.map((name) => `@interface ${name} : NSObject\n@end`),
      "",
    ].join("\n"),
  );
}

/** Builds the helper into `axeDirectory`, beside AXe's `Frameworks`, and
 * checks that it starts there. Returns the helper's path. */
export function buildSimulatorHid({ axeDirectory, quiet = false }) {
  if (process.platform !== "darwin") {
    throw new Error("[build-simulator-hid] iOS simulators need macOS");
  }
  const source = join(repoRoot, SIMULATOR_HID_SOURCE);
  for (const name of COMPILE_FRAMEWORKS) {
    if (!existsSync(join(axeDirectory, "Frameworks", `${name}.framework`))) {
      throw new Error(
        `[build-simulator-hid] ${axeDirectory} has no ${name}.framework; run pnpm stage:axe`,
      );
    }
  }
  const work = mkdtempSync(join(tmpdir(), "zeros-simulator-hid-"));
  try {
    const frameworks = join(work, "Frameworks");
    for (const name of COMPILE_FRAMEWORKS) {
      const framework = join(frameworks, `${name}.framework`);
      cpSync(join(axeDirectory, "Frameworks", `${name}.framework`), framework, {
        recursive: true,
        verbatimSymlinks: true,
      });
      for (const file of interfaces(framework)) {
        writeFileSync(file, readableInterface(readFileSync(file, "utf8"), name));
      }
    }
    const coreSimulator = join(work, "CoreSimulator");
    writeCoreSimulatorModule(coreSimulator);

    const built = join(work, SIMULATOR_HID_BINARY);
    const compile = spawnSync(
      "xcrun",
      [
        "swiftc",
        "-O",
        "-parse-as-library",
        "-swift-version",
        "5",
        "-target",
        TARGET,
        "-module-cache-path",
        join(work, "ModuleCache"),
        "-F",
        frameworks,
        "-I",
        coreSimulator,
        "-framework",
        "FBControlCore",
        "-framework",
        "FBSimulatorControl",
        "-Xlinker",
        "-rpath",
        "-Xlinker",
        "@executable_path/Frameworks",
        source,
        "-o",
        built,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    if (compile.status !== 0) {
      const output = `${compile.stderr ?? ""}${compile.stdout ?? ""}`.trim();
      throw new Error(
        `[build-simulator-hid] swiftc failed (${compile.error?.message ?? `status ${compile.status}`}):\n` +
          output.slice(-4_000),
      );
    }

    const destination = join(axeDirectory, SIMULATOR_HID_BINARY);
    const incoming = `${destination}.incoming`;
    rmSync(incoming, { force: true });
    cpSync(built, incoming);
    chmodSync(incoming, 0o755);
    const version = spawnSync(incoming, ["--version"], { encoding: "utf8" });
    if (version.status !== 0 || version.stdout.trim() !== String(SIMULATOR_HID_PROTOCOL)) {
      rmSync(incoming, { force: true });
      throw new Error(
        `[build-simulator-hid] the helper doesn't start beside AXe's frameworks: ` +
          `${(version.stderr || version.stdout || `status ${version.status}`).trim().slice(-2_000)}`,
      );
    }
    renameSync(incoming, destination);
    if (!quiet) {
      const swift = execFileSync("xcrun", ["swiftc", "--version"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
        .split("\n")
        .find((line) => line.includes("Swift version"))
        ?.trim();
      console.log(`[build-simulator-hid] ${SIMULATOR_HID_BINARY} → ${destination} (${swift ?? "swiftc"})`);
    }
    return destination;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(filename)) {
  try {
    buildSimulatorHid({ axeDirectory: join(repoRoot, "binaries", "axe") });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
