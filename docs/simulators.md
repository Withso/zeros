# Simulators

Zeros shows iOS simulators and Android virtual devices in a workbench tab,
and agents can use the same devices through the `zeros_device` tools.
Everything runs on the user's Mac, in Local and organization-local
workspaces. The UI calls an Android virtual device an "Android Simulator";
code keeps "emulator" where it means Google's Android Emulator. This guide
owns the Simulator tab, DeviceHub, Android devices, idle shutdown, the agent
tools and Settings → Simulators.

Related guides:

- [Agent control](agent-control.md) owns the shared approval, control bar and
  Stop contracts that the simulator tools follow, and the
  [rollout](agent-control.md#rollout) that decides who has simulators at all.
- [Native computer and browser use](native-computer-use.md) owns Zeros
  computer use, which controls Mac apps rather than simulators.

## The Simulator tab

- **Tab model.** One tab type, `simulator`, with `simulatorPlatform`
  (`ios` or `android`) and an optional `simulatorDeviceId`. It has its own
  branch in `normalizeWorkbenchTabs`, which keeps only those fields, so a
  restored tab never carries a file, URL or terminal identity.
- **"+" menu.** "iOS Simulator" and "Android Simulator" sit after Terminal in
  Local workspaces only. Each reuses a Simulator tab of its platform that has
  no device yet.
- **Setup screen.** Before a device is attached, the tab says what's
  installed or missing (`simulatorSetupRow`). For iOS it offers "Get Xcode",
  "Install iOS runtime" (with progress and Cancel) and "Check again"; Android
  has its own fixes, described under [Android](#android). "Attach simulator"
  takes a running device no other tab shows, else the first phone that can
  boot; its menu lists "Booted" and "Available (will boot)" devices. A
  shut-down device boots when chosen.
- **Live view.** The tab streams only while it is visible and the window is
  not hidden. A press reaches the device as the pointer moves, so a list
  follows it and a long press opens its menu while the button is still
  down. Option-drag pinches, scrolling swipes, and typing and paste go to
  the device keyboard. A press ends without counting when the pointer is
  lost or an agent takes over.
- **Island.** Home, Rotate, Screenshot, Record, Annotate and Light/Dark,
  built from `Toolbar` and `IconButton`; Android devices also get Back.
  Rotate turns both the frame and the device, so iPad apps re-lay out.
  DeviceHub publishes a turn as it starts and turns back if it fails, so the
  frame turns with the screen rather than after it. The turn animates for
  200 ms, or instantly with reduce motion. The capture buttons are described
  under [Captures](#captures).
- **Frames.** Each iOS device type names its frame in Xcode's DeviceKit
  (`/Library/Developer/DeviceKit/Chrome`). Main converts the parts to PNG with
  macOS's `sips`, caches them per DeviceKit version under the app's private
  `simulators/frames` folder, and never bundles, commits or uploads them
  (`electron/devices/ios-device-frame.ts`). Android frames come from the
  installed Android Studio (see [Android](#android)). When anything is
  missing, the tab draws its own frame.

Boot warnings and failures are toasts: a warning when the Mac has less than
3 GB available or two devices already run, and an error when a boot fails.

## Captures

Screenshot, Record and Annotate make files the user can give a chat.
`SimulatorCaptures` (`electron/devices/simulator-captures.ts`) in main takes
and saves them and remembers which file each capture ID names. The renderer
only echoes those IDs through the `simulator_*` capture commands and never
sends a path. Outcomes and failures are toasts.

- **Screenshots.** The screen flashes, and `simctl io screenshot` (or the
  Android Emulator's own screenshot) saves a PNG to Downloads under the name
  Simulator.app gives its own, such as
  `Simulator Screenshot - iPhone 17 - 2025-10-12 at 14.03.22.png`
  (`capture-names.ts`). A name that is taken gets " (2)" and so on; Zeros
  never writes over a file.
- **Recordings.** Record starts `simctl io recordVideo` (H.264 MP4), or on
  Android the device's own `screenrecord`, and the button becomes Stop with
  a red dot and the elapsed time. Stop saves
  `Simulator Screen Recording - … .mp4` to Downloads. A recording keeps its
  device from idle shutdown. It also ends after one hour, when its device
  stops, when the recorder exits or when Zeros quits; main then sends
  `simulator-recording-end`, and a toast says why and whether the video was
  saved. `screenrecord` stops by itself after three minutes on Android 13
  and earlier (API 33 and below).
- **Thumbnails.** Each saved capture shows as a thumbnail at the window's
  bottom right, above any toasts and the browser's picture in picture
  (`simulator-capture-stack.tsx`). Up to three stack. Pointing at or
  focusing them spreads them and keeps them; otherwise each leaves after 5
  seconds. Dragging one carries the saved file itself, through a native drag
  that main starts, so it drops into a composer or Finder. Add to chat puts
  the file in the open chat's composer as a drop would. A recording larger
  than the attachment limit stays in Downloads.
- **Recording timelines.** While a device records, main logs what the user
  and agents do, named from the screen's UI elements where it can, such as
  `tap Button "Sign in"`. Typing into a password field is logged as a
  character count, never the text (`recording-timeline.ts`). The timeline is
  saved in the app's private `simulators/recordings` folder under the video's
  fingerprint: its size and the SHA-256 of its first and last 64 KiB. So
  renaming or moving the video doesn't lose it. The newest 200 are kept.
- **Videos in a chat.** Any video added to a composer (MP4, M4V, MOV or
  WebM), not only a recording, brings up to eight JPEG key frames and a
  `…-timeline.txt` beside its chip (`composer-editor/video-key-frames.ts`).
  The frames are the first and last, a moment after recorded actions spread
  across the video, then the biggest scene changes. The renderer reads them
  with a video element and a canvas, so cloud chats get them too and no
  ffmpeg ships. The text gives the video's length and its frames and, for a
  Zeros recording (found by fingerprint through
  `simulator_recording_timeline`), each action as
  `00:03.2 tap Button "Sign in"`, naming the agent when an agent did it.
  Sending waits a few seconds for the frames, then sends what it has.

### Annotate

- **Freezing.** Annotate captures the screen as a PNG and its UI elements
  (from AXe's `describe-ui`, or `uiautomator dump` on Android) in one
  snapshot (`simulator_annotation_snapshot`), upright even when the device is
  turned. The live view stops, and the
  island becomes the annotation toolbar: Pen, Line, Arrow, Rectangle,
  Ellipse, Text, a color (red, yellow, green, blue or violet), Undo (⌘Z),
  Redo (⇧⌘Z), Clear, Add to chat and Close (Esc). Clear is a step Undo
  takes back.
- **Marks.** Each mark gets a number. A shape asks for a note as soon as it
  is drawn, and clicking a number edits that mark's note. Strokes, text and
  numbers are sized for a phone's screen and grow in proportion on a tablet.
  The next annotation starts with the last tool and color.
- **Keeping and leaving.** The annotation belongs to its tab
  (`simulator-annotation-store.ts`), so switching tabs keeps it. Close or Esc
  leaves at once when there are no marks. With marks, a dialog asks before
  discarding them (⌘↵ discards). Closing the tab, attaching another device
  and detaching ask the same way.
- **Add to chat** draws the marks and numbers on the screen at the
  screenshot's own resolution and puts it in the open chat's composer with a
  marks file: `Simulator Annotation - … .png` and `… marks.txt`. The marks
  file names the device, OS, orientation and app. It then lists each mark by
  number with its color, kind, position in points, note and the UI elements
  it is on: what a box, ellipse or pen mark encloses (else what is under its
  middle), what an arrow points at, what is at a line's ends, and what text
  was written on (`simulator-annotation-model.ts`). Annotations are not saved
  to Downloads.

## DeviceHub

`DeviceHub` (`apps/desktop/electron/devices/device-hub.ts`) runs in Electron
main and owns booting and shutdown, which devices Zeros booted, live views,
the user's input and idle shutdown. Every device ID it acts on comes from its
own latest device list.

- Simulator tabs call it through the `simulator_*` IPC commands
  (`electron/ipc/commands/simulators.ts`). Main sends `simulator-hub-state`
  snapshots on every change and `simulator-frame` for live views.
- The renderer mirrors the latest snapshot (`simulator-hub-store.ts`). The
  first Simulator tab, or opening Settings → Simulators, reads it once; that
  read is what starts the device tools. Nothing runs at launch unless Zeros
  booted devices before, which still need idle shutdown.
- Main re-reads devices every 10 seconds only while a live view is open or
  Zeros is booting one, and every 2 seconds while a device starts or stops
  outside Zeros. So while the window is visible, the active tab re-reads
  them itself when it shows the setup screen or a shut-down device: every
  10 seconds and whenever the window comes forward. A device started or
  made in Xcode, Android Studio or a terminal then shows up.
- For iOS, `xcrun simctl` lists, boots and shuts down devices and changes
  their appearance. AXe, the MIT-licensed tool staged by
  `scripts/stage-axe.mjs`, streams frames. The user's touches, keys, buttons
  and turns go straight to the device's HID through `zeros-simulator-hid`
  (`native/simulator-hid/main.swift`, client in `simulator-hid.ts`): one
  resident process that links AXe's idb frameworks and keeps a connection
  per device, so an input takes about a millisecond where an AXe command
  takes about a second to start. A device's live view opening starts it and
  connects. Its points are the device's portrait screen, as the Simulator
  tab sends them, in every orientation; AXe's commands instead take points
  in the turned app's own space. A connection from an earlier boot keeps
  taking inputs but never delivers them, so the helper connects again
  whenever CoreSimulator says the device booted since. An input the device
  doesn't answer within a second of playing out fails with `no-answer` and
  is never resent, since it may still arrive. When the helper is missing or
  can't start, input goes through AXe; after a failure the helper is tried
  again 10 seconds later. It types US keyboard characters only, as AXe
  does. If Zeros goes away mid-press, the helper lifts the finger.
  agent-device runs most agent actions (see [Agents](#agents-zeros_device)),
  pinches and upside-down turns, since XCTest reports whether the device
  kept one (iPhones without a Home button don't). Android devices go
  through `AndroidDevices`, below.
- **Live presses.** `TouchStream` (`touch-stream.ts`) sends each step of
  the user's finger as it happens: to the helper on iOS (helper protocol 2)
  and to the emulator's control service on Android. One step is in flight
  per device; moves that pile up behind a slow device fold into the
  newest, and downs and lifts always go out, in order. A press the helper
  can't take live goes out whole through AXe once it ends. Closing a view,
  or the window, lifts a finger left down on it, and a device that stops
  drops its press.
- One frame stream runs per device while any tab shows it, and frames that
  did not change are not encoded or sent (`live-view.ts`).
- The devices Zeros booted are saved in `simulators/booted-devices.json`, so
  Zeros never shuts down a device someone else started, even after a crash.
  On quit, main shuts down what Zeros booted and stops agent-device, each
  within 8 seconds. An Android emulator that is still saving its Quick Boot
  state then finishes and quits on its own.

## Android

`AndroidDevices` (`electron/devices/android-devices.ts`) gives DeviceHub the
Android virtual devices (AVDs) on the Mac. It reads the Android SDK, Android
Studio and the AVDs from their own files (`android-sdk.ts`), so listing
devices runs no tools.

- **Setup.** The setup row sends what Zeros can't fix itself to Android
  Studio, which installs the emulator, system images and devices: "Get
  Android Studio" or "Open Android Studio", then "Check again". With the
  emulator and a system image but no devices, "Create device" runs the SDK's
  `avdmanager` to make the newest plain Pixel profile with the newest stable
  Android image on the Mac, such as "Pixel 10 with Android 17", configured
  like a device Android Studio makes.
- **Running devices.** Zeros starts each emulator with
  `-no-window -no-boot-anim -grpc-use-token`, in its own process group and
  with only the environment variables the emulator reads, so a device Zeros
  starts shows only in Zeros. A boot waits until Android has finished
  starting (a cold boot can take a few minutes) and turns the device upright,
  since Quick Boot restores the last orientation. Shutting down saves the
  Quick Boot state. An emulator started outside Zeros shows as running, but
  Zeros has no token to drive it and says to stop it there and start it in
  Zeros.
- **Graphics.** With Automatic graphics, the emulator draws Android 15 and
  later (API 35 and up) in software on a Mac, at about 16 frames a second,
  because they need OpenGL ES 3.1. So Zeros starts those devices with
  `-gpu host -feature GuestAngle,VulkanSnapshots` (`emulatorGraphicsArgs`):
  ANGLE over the Mac's GPU, through Vulkan, draws them at 60. Without
  VulkanSnapshots, which is off by default, the emulator saves no Quick Boot
  state while drawing through Vulkan and deletes what it had. A device set
  to Hardware or Software in Android Studio keeps its setting
  (`hw.gpu.mode`). Quick Boot state saved with one renderer doesn't load
  with the other, so moving an Automatic device between Android Studio and
  Zeros cold-boots it once.
- **Keyboard.** A boot and a shutdown each give the device its own keyboard
  back if an agent session left agent-device's selected; see "Android
  keyboard" under [Agents](#agents-zeros_device).
- **Live view and input.** The emulator's own gRPC control service streams
  the screen and takes touches, keys, text, the clipboard, rotation and
  power (`android-emulator.ts`). `android-grpc.ts` speaks it over Node's own
  HTTP/2 with a small protobuf codec, so no gRPC or protobuf runtime ships.
  Frames come only when the screen changes, at most 30 a second, turned back
  to the device's natural orientation as an iOS simulator's are. Light/Dark
  uses `adb shell cmd uimode night`.
- **Captures.** Screenshots come from the emulator's control service,
  recordings from the device's own `screenrecord` (`android-recorder.ts`),
  pulled to the Mac when they stop and removed from the device. UI elements
  for timelines and annotations come from `uiautomator dump`
  (`android-ui-elements.ts`), using the iOS element type names, so both
  platforms read the same.
- **Frames.** Android Studio's device art (its `device-art-resources`)
  gives a picture of the device, where its screen sits and a mask that
  rounds the screen and covers the camera (`android-device-frame.ts`). It is
  read from the user's own Android Studio and never bundled. Devices without
  art, such as Android Studio's "Medium Phone", get the frame Zeros draws.

## Idle shutdown

Devices Zeros booted shut down after 30 minutes without use by default; the
other choices are 15 minutes, 1 hour, 2 hours and Never. Use is the user's
input, an agent action, or a hold such as an app install. Watching a live view
is not use. One minute before shutdown, each device gets its own toast with
"Keep running", which stays until the timer runs out
(`electron/devices/idle-shutdown.ts`). Devices booted outside Zeros are never
shut down.

## Agents: `zeros_device`

The engine serves the curated `zeros_device` tools as a loopback MCP server
to Claude, Codex and Cursor in Local workspaces while "Let agents use
simulators" is on. `resolveDeviceToolRoute`
(`packages/protocol/src/device-tools.ts`) decides the route when a provider
boots and again on every call, so turning the switch off applies to a running
agent.

The tools are `list_devices`, `boot_device`, `list_apps`, `install_app`,
`launch_app`, `open_url`, `snapshot`, `screenshot`, `tap`, `type_text`,
`press_key`, `swipe`, `scroll`, `pinch`, `press_button`, `rotate` and
`set_appearance`, defined once in `DEVICE_TOOL_DEFINITIONS`. Every action names
one simulator by the ID `list_devices` returns; arguments never choose the
runner session, its state or a configuration file.

- **Where calls run.** `ZerosDeviceTools` in the engine binds each call to
  the admitted workspace, conversation and agent, then sends it to the
  agent-control service (`/v1/device/invoke`, `/v1/device/release`). In main,
  `DeviceUseController` checks the settings, the approval and which chat holds
  the device, then runs the action through DeviceHub or agent-device.
  agent-device runs under `ELECTRON_RUN_AS_NODE` with private state under the
  app's `simulators/agent-device` folder, and is told where the Android SDK
  is.
- **Points on both platforms.** Tool coordinates and screenshots are in the
  screen's points. On Android, `DeviceUseController` converts them to and
  from the device's pixels with its density. agent-device drives Android
  through adb, in sessions that are not tied to one app. On iOS its session
  is bound to the app in front and moves when another app comes forward, so
  its runner never leaves its own blank app on screen.
- **Fast paths.** Keys, buttons, rotation and appearance always go through
  DeviceHub. Taps, long presses, double taps and swipes at points do too,
  in milliseconds rather than the second agent-device takes, when the
  device is upright and its latest screenshot was taken upright at its
  screen's size, so the agent's points are the device's own. Otherwise, and
  for refs, text, scrolls, pinches, snapshots and apps, agent-device runs
  the action.
- **Screenshots.** For an upright device that DeviceHub drives, Zeros takes
  the screenshot itself: the frame the Simulator tab shows, or a capture
  when no tab shows the device, scaled to points (`screen-images.ts`). An
  image of another shape, as when an app turns an Android display, is left
  to agent-device, which knows how it turned.
- **Settling.** agent-device's screenshots took long enough for the screen
  to settle. Zeros' own wait instead for what the device's latest action
  set off: until the device had time to answer (250 ms, or 700 ms after
  Home or Lock on iOS, which waits out a double press) and the live view
  has shown the same screen for 250 ms. Without a live view, a screenshot
  waits 350 ms past the answer time. None waits more than 2 seconds after
  the action. Gestures keep 400 ms apart, so two taps never make a double
  tap, and a double tap's two taps go 100 ms apart.
- **Android keyboard.** While an agent uses an Android device, agent-device's
  own input method is its keyboard, so `type_text` can type any text. Ending
  the session gives the device its own keyboard back; Zeros ends it before it
  shuts an emulator down, and agent-device ends every session when Zeros
  quits. A session that couldn't end cleanly leaves agent-device's keyboard
  selected, and the device then shows no on-screen keyboard, in Android
  Studio too. So when Zeros starts or shuts down a device and finds that
  keyboard selected, it selects the device's own: the one agent-device
  noted it replaced (`agent_device_ime_helper_previous_ime`), else the
  first other one. Zeros reads the setting back before it deletes
  agent-device's note, and a boot finishes this check before it says the
  device started, so it never switches away from a session that opens
  right after.
- **Platform differences.** `press_button` with `back` works only on
  Android; on iOS the agent is told to use the app's own back control.
  `install_app` takes an `.apk` on Android and a simulator `.app` on iOS.
- **Approvals.** A `PermissionCard` asks once per device per chat, and again
  before any boot.
- **One chat per device.** Another chat's call fails with "Another chat is
  using …", so the agent can pick another simulator.
- **The tab follows the agent.** `SimulatorAgentController` opens a Simulator
  tab for the held device in its chat's workspace. It is revealed when that
  chat is on screen and placed quietly otherwise; a collapsed workbench is
  expanded on reveal.
- **While an agent holds a device**, its tab shows the `AgentControlBar` pill
  beside the island (the agent's name, what it is doing, Stop and an `esc`
  hint) and soft touch dots where the agent taps, swipes and pinches. The
  user's own taps, keys and island buttons are held until control returns.
- **Stop and Esc.** The pill's Stop, or Esc in the tab, ends only the agent's
  use of that device. Its running action and any later call on that device in
  the same turn report "The user stopped you on …". Composer Stop and the end
  of a turn release every device the chat holds.

## Settings → Simulators

The page sits in the Agents group (`settings/simulators-panel.tsx`). It shows
each platform's setup status with the same fixes the setup screen offers, then
the switches below. Organization pages show the controls only for that
organization's Local workspace, and otherwise say simulators are unavailable
in cloud workspaces.

The settings live in the `[simulators]` table, which only the user and
managed layers may set. A repository file's `[simulators]` table is ignored
with a warning. Organizations can lock any key; a locked row shows "Managed".

| Key                  | Default | Meaning                                                               |
| -------------------- | ------- | --------------------------------------------------------------------- |
| `enabled`            | `true`  | "Let agents use simulators". Off, agents get no `zeros_device` tools. |
| `idle_shutdown`      | `"30m"` | "Shut down idle simulators after": `15m`, `30m`, `1h`, `2h`, `never`. |
| `show_agent_touches` | `true`  | "Show agent touches": draw touch dots where the agent acts.           |

The renderer pushes the resolved values to DeviceHub with
`simulator_preferences_update`; main applies them to idle shutdown, agent
admission and touch dots.

## Local and cloud

Cloud workspaces get no simulator tools: the "+" menu hides the simulator
entries, the tab shows a local-only notice and reads no devices, engine
admission serves no `zeros_device` tools to the cloud worker or cloud
placements, and Settings → Simulators says it is for Local workspaces only.

## Packaging and licenses

- `binaries/axe` is staged by `scripts/stage-axe.mjs`, which pins the release
  SHA-256, thins it with `lipo` and verifies the Developer ID signatures.
  It also removes the release's empty framework directories and the links
  into them: electron-builder copies only files and links, and a link left
  dangling in the app fails its signing pass. `beforePack` runs the script,
  and the packaged app resolves `Contents/Resources/axe/axe`.
- `scripts/build-simulator-hid.mjs` compiles `zeros-simulator-hid` into the
  staged folder, beside the frameworks it loads, with `xcrun swiftc`. It
  reads AXe's Swift interfaces from private copies, with module-qualified
  names the newer compiler can't resolve rewritten, and a stand-in for
  CoreSimulator's few classes; nothing links those copies. `stage-axe`
  builds it before the folder is put in place; `beforePack` passes
  `--require-simulator-hid`, so a package never ships without it, while a
  checkout warns and keeps AXe alone. Rebuild after editing the Swift source
  with `pnpm build:simulator-hid`. Signed with the app's hardened runtime,
  the helper loads AXe's frameworks only because the inherited entitlements
  disable library validation.
- agent-device runs from `app.asar.unpacked`, so
  `**/node_modules/agent-device/**/*` is in `asarUnpack`. Its Android helper
  apps (an input method and a snapshot helper) ship inside the package.
- `pnpm check:packaging-paths` guards both, and `pnpm check:licenses` covers
  their notices in `THIRD-PARTY-LICENSES.txt`.
- Android needs nothing staged: the emulator, adb and avdmanager come from
  the user's Android SDK. Neither Xcode's nor Android Studio's frames are
  redistributed (see `THIRD-PARTY-NOTICES.md`).

## Verification

- `apps/desktop/electron/__tests__/simulator-device-hub.test.ts`: booting,
  ownership, live views, input, rotation, preferences and idle shutdown
  against fake device tools.
- `simulator-device-use.test.ts`, `simulator-agent-device.test.ts`,
  `simulator-device-tools.test.ts`, `simulator-device-frame.test.ts` and
  `simulator-captures.test.ts` in the same folder: approvals, holders, Stop,
  agent-device output and Android sessions, points and pixels, DeviceKit
  frames, and saving screenshots, recordings, timelines and annotation
  snapshots.
- `simulator-hid.test.ts` in the same folder: the input helper's requests,
  replies, start-up, AXe fallback, timeouts and turns, against a fake helper;
  `scripts/__tests__/build-simulator-hid.test.ts`: its interface rewrite.
  `touch-stream.test.ts`: live presses, folded moves, lifts and the AXe
  fallback. `simulator-screen-images.test.ts`: Zeros' own screenshots for
  agents.
- `simulator-android-*.test.ts` in the same folder: reading the SDK, AVDs
  and "Create device", starting and stopping emulators with their graphics
  and keyboards, the gRPC client and control service, input, recordings, UI
  elements and Android Studio frames, against fake tools and a fake
  emulator.
- `apps/desktop/src/engine/agent-control/__tests__/zeros-device-tools.test.ts`
  and `packages/protocol/src/__tests__/device-tools.test.ts`: admission, the
  route and tool parsing. `simulator-captures.test.ts` in the same protocol
  folder covers capture names, fingerprints and parsing.
- `apps/desktop/src/renderer/features/simulators/__tests__/` and
  `features/settings/__tests__/simulator*.test.ts`: tab model, geometry, touch
  motion, stores, captures, annotation marks and painting, and the Settings
  page. `features/agent/__tests__/video-key-frames.test.ts` and
  `composer-video-key-frames.test.ts` cover a video's key frames and
  timeline.
- `pnpm test:ui-smoke` runs the `simulator-tab` scenario
  (`scripts/ui-smoke-simulator-tab.mjs`) against a fake DeviceHub: setup,
  live frames, input, Rotate, pinch, the agent pill, Stop and Esc,
  screenshots, recordings and their thumbnails, Annotate, agent tab
  placement, Android setup, frames and Back, and the cloud notice.
- Real simulators are checked only on a Mac with Xcode, and Android devices
  only on a Mac with the Android SDK; report those runs separately from CI.
