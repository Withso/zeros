// zeros-simulator-hid: the user's touches, keys, buttons and turns for iOS
// simulators, sent straight to each device's HID by one resident process.
//
// An AXe command starts over for every input: it loads the simulator
// frameworks, opens the device set, connects to the device's HID and asks
// accessibility which way the screen is turned, about a second in all. This
// helper does the first three once, connects to each device once, and then
// sends an input in about a millisecond. It links the idb frameworks AXe
// ships (FBSimulatorControl, MIT) from the `Frameworks` folder beside it;
// scripts/build-simulator-hid.mjs builds it into AXe's staged folder.
//
// Protocol (SIMULATOR_HID_PROTOCOL in electron/devices/simulator-hid.ts):
// one JSON request per line on stdin and one JSON reply per line on stdout.
// The first line out is {"ready":true,"protocol":2}, or {"ready":false,
// "error":"…"} just before the helper exits. Each device's requests run in
// the order they arrive; replies for different devices may interleave.
//   {"id":1,"udid":"…","op":"tap","x":10,"y":20}
//   → {"id":1,"ok":true} or {"id":1,"ok":false,"code":"…","error":"…"}
// "touch" is one step of a finger as the user moves it ("phase" is down,
// move or up), or of two fingers with "x2" and "y2".
// An input the device doesn't answer within a second of playing out fails
// with "no-answer"; it may still arrive, so it is never sent again.
// Points are the device's own, in its natural (portrait) orientation
// whichever way it is turned, which is how its HID reads them.

import Foundation
import FBControlCore
import FBSimulatorControl

// Keep in sync with SIMULATOR_HID_PROTOCOL in electron/devices/simulator-hid.ts
// and scripts/build-simulator-hid.mjs.
let protocolVersion = 2

struct Request: Decodable {
  let id: Int
  let udid: String
  let op: String
  var x: Double?
  var y: Double?
  var toX: Double?
  var toY: Double?
  var x2: Double?
  var y2: Double?
  var phase: String?
  var seconds: Double?
  var text: String?
  var usage: UInt32?
  var button: String?
  var orientation: String?
}

/// A failure the helper can name; anything else is reported as "failed".
struct Failure: Error {
  let code: String
  let message: String
}

func describe(_ error: Error) -> String {
  let text = (error as? LocalizedError)?.errorDescription ?? String(describing: error)
  return String(text.prefix(500))
}

/// Replies come from every device's lane; one line must never split another.
final class Output: @unchecked Sendable {
  private let lock = NSLock()

  func send(_ object: [String: Any]) {
    guard var data = try? JSONSerialization.data(withJSONObject: object) else { return }
    data.append(0x0A)
    lock.lock()
    defer { lock.unlock() }
    FileHandle.standardOutput.write(data)
  }
}

/// Each device's requests run one after another, so a tap never lands in the
/// middle of the drag before it; different devices don't wait for each other.
final class Lanes: @unchecked Sendable {
  private let lock = NSLock()
  private var tails: [String: Task<Void, Never>] = [:]

  func enqueue(_ udid: String, _ work: @escaping @Sendable () async -> Void) {
    lock.lock()
    defer { lock.unlock() }
    let previous = tails[udid]
    tails[udid] = Task {
      await previous?.value
      await work()
    }
  }

  /// Waits for everything enqueued so far.
  func drain() async {
    lock.lock()
    let pending = Array(tails.values)
    lock.unlock()
    for task in pending { await task.value }
  }
}

/// The finger each device has down, so the helper can lift it if Zeros goes
/// away mid-press; otherwise the device stays pressed until something else
/// touches it.
final class Fingers: @unchecked Sendable {
  private let lock = NSLock()
  private var down: [String: Request] = [:]

  func note(_ request: Request) {
    guard request.op == "touch" else { return }
    lock.lock()
    defer { lock.unlock() }
    if request.phase == "up" {
      down.removeValue(forKey: request.udid)
    } else {
      down[request.udid] = request
    }
  }

  /// Each finger still down, as the request that lifts it.
  func lifts() -> [Request] {
    lock.lock()
    defer { lock.unlock() }
    return down.values.map { last in
      var lift = last
      lift.phase = "up"
      return lift
    }
  }
}

/// Claims one outcome of a race.
final class Once: @unchecked Sendable {
  private let lock = NSLock()
  private var claimed = false

  func claim() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    if claimed { return false }
    claimed = true
    return true
  }
}

/// `work`'s result, or a "no-answer" failure once `seconds` pass without it.
/// A HID connection can drop a send without ever answering, and that send's
/// task then never ends, so it runs on its own rather than as a child task:
/// a task group would wait for it forever.
func answered<T: Sendable>(
  within seconds: Double, _ work: @escaping @Sendable () async throws -> T
) async throws -> T {
  try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<T, Error>) in
    let once = Once()
    Task {
      do {
        let value = try await work()
        if once.claim() { continuation.resume(returning: value) }
      } catch {
        if once.claim() { continuation.resume(throwing: error) }
      }
    }
    Task {
      try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
      if once.claim() {
        continuation.resume(
          throwing: Failure(code: "no-answer", message: "The simulator didn't answer."))
      }
    }
  }
}

/// How long the device needs to play `event` out, from its pauses.
func playSeconds(_ event: FBSimulatorHIDEvent) -> Double {
  if case .delay(let pause) = event { return pause }
  return event.subEvents?.reduce(0) { $0 + playSeconds($1) } ?? 0
}

func eventCount(_ event: FBSimulatorHIDEvent) -> Int {
  event.subEvents?.reduce(0) { $0 + eventCount($1) } ?? 1
}

/// A send answers in well under a millisecond per event, after its pauses.
func answerSeconds(_ event: FBSimulatorHIDEvent) -> Double {
  1 + playSeconds(event) + 0.001 * Double(eventCount(event))
}

/// Connecting takes about 20 ms, and a few hundred the first time.
let connectSeconds = 3.0

/// When the device last started. A connection from an earlier boot keeps
/// taking inputs, but never delivers or answers them, so a new boot needs a
/// new connection. Nil if CoreSimulator stops saying.
func lastBooted(_ simulator: FBSimulator) -> Date? {
  let device = simulator.device as NSObject
  guard device.responds(to: NSSelectorFromString("lastBootedAt")) else { return nil }
  return device.value(forKey: "lastBootedAt") as? Date
}

/// One HID connection per device, made on first use and again each time the
/// device starts.
actor Connections {
  private struct Connection {
    let hid: FBSimulatorHID
    let booted: Date?
  }

  private let control: FBSimulatorControl
  private let logger: any FBControlCoreLogger
  private var open: [String: Connection] = [:]

  init(control: FBSimulatorControl, logger: any FBControlCoreLogger) {
    self.control = control
    self.logger = logger
  }

  func hid(_ udid: String) async throws -> FBSimulatorHID {
    guard let simulator = control.set.simulator(withUDID: udid) else {
      drop(udid)
      throw Failure(code: "unknown-device", message: "No simulator has this UDID.")
    }
    guard simulator.state == .booted else {
      drop(udid)
      throw Failure(code: "not-booted", message: "The simulator isn't running.")
    }
    let booted = lastBooted(simulator)
    if let connection = open[udid], connection.booted == booted { return connection.hid }
    drop(udid)
    let hid = try await answered(within: connectSeconds) { try await simulator.connectToHID() }
    open[udid] = Connection(hid: hid, booted: booted)
    return hid
  }

  func drop(_ udid: String) {
    open.removeValue(forKey: udid)?.hid.disconnect()
  }

  func send(_ event: FBSimulatorHIDEvent, to udid: String) async throws {
    do {
      try await attempt(event, to: udid)
    } catch let failure as Failure {
      throw failure
    } catch {
      // The connection refused it, so nothing arrived: try a new one.
      drop(udid)
      try await attempt(event, to: udid)
    }
  }

  private func attempt(_ event: FBSimulatorHIDEvent, to udid: String) async throws {
    let hid = try await hid(udid)
    let logger = self.logger
    do {
      try await answered(within: answerSeconds(event)) {
        try await hid.send(event: event, logger: logger)
      }
    } catch let failure as Failure where failure.code == "no-answer" {
      // It may still arrive, so it isn't sent again; the next input
      // connects afresh.
      drop(udid)
      throw failure
    }
  }
}

func number(_ value: Double?, _ name: String) throws -> Double {
  guard let value, value.isFinite, value >= 0 else {
    throw Failure(code: "bad-request", message: "\(name) must be a number of points.")
  }
  return value
}

func duration(_ value: Double?) throws -> Double {
  guard let value, value.isFinite, value > 0, value <= 30 else {
    throw Failure(code: "bad-request", message: "seconds must be between 0 and 30.")
  }
  return value
}

/// A drag moves the finger about every frame at 60 Hz, as a hand would.
let dragStepSeconds = 1.0 / 60.0

func drag(from: CGPoint, to: CGPoint, seconds: Double) -> FBSimulatorHIDEvent {
  let steps = max(1, Int((seconds / dragStepSeconds).rounded()))
  let pause = seconds / Double(steps)
  var events: [FBSimulatorHIDEvent] = [.touch(direction: .down, x: from.x, y: from.y)]
  for step in 1...steps {
    let progress = Double(step) / Double(steps)
    events.append(.delay(pause))
    events.append(
      .touch(
        direction: .down,
        x: from.x + (to.x - from.x) * progress,
        y: from.y + (to.y - from.y) * progress
      ))
  }
  events.append(.touch(direction: .up, x: to.x, y: to.y))
  return .composite(events)
}

/// One step of a finger the user is moving. A finger that is down and
/// reported somewhere new has moved there, as each step of `drag` does.
func touch(_ request: Request) throws -> FBSimulatorHIDEvent {
  let direction: FBSimulatorHIDDirection
  switch request.phase {
  case "down", "move": direction = .down
  case "up": direction = .up
  default: throw Failure(code: "bad-request", message: "phase must be down, move or up.")
  }
  let finger = CGPoint(x: try number(request.x, "x"), y: try number(request.y, "y"))
  guard request.x2 != nil || request.y2 != nil else {
    return .touch(direction: direction, x: finger.x, y: finger.y)
  }
  let second = CGPoint(x: try number(request.x2, "x2"), y: try number(request.y2, "y2"))
  return .twoFingerTouch(direction: direction, finger1: finger, finger2: second)
}

let leftShift: UInt32 = 225

/// The US keyboard, as HID usages: the characters AXe's `type` takes.
let usKeyboard: [Character: (usage: UInt32, shift: Bool)] = {
  var keys: [Character: (usage: UInt32, shift: Bool)] = [:]
  for (offset, letter) in "abcdefghijklmnopqrstuvwxyz".enumerated() {
    keys[letter] = (UInt32(4 + offset), false)
    keys[Character(letter.uppercased())] = (UInt32(4 + offset), true)
  }
  for (offset, digit) in "1234567890".enumerated() {
    keys[digit] = (UInt32(30 + offset), false)
  }
  for (offset, symbol) in "!@#$%^&*()".enumerated() {
    keys[symbol] = (UInt32(30 + offset), true)
  }
  let pairs: [(UInt32, Character, Character)] = [
    (45, "-", "_"), (46, "=", "+"), (47, "[", "{"), (48, "]", "}"), (49, "\\", "|"),
    (51, ";", ":"), (52, "'", "\""), (53, "`", "~"), (54, ",", "<"), (55, ".", ">"),
    (56, "/", "?"),
  ]
  for (usage, plain, shifted) in pairs {
    keys[plain] = (usage, false)
    keys[shifted] = (usage, true)
  }
  keys[" "] = (44, false)
  keys["\t"] = (43, false)
  for newline: Character in ["\n", "\r", "\r\n"] {
    keys[newline] = (40, false)
  }
  return keys
}()

func keystrokes(_ text: String) throws -> FBSimulatorHIDEvent {
  var events: [FBSimulatorHIDEvent] = []
  // Checked before anything is typed, so text never arrives half typed.
  for character in text {
    guard let key = usKeyboard[character] else {
      throw Failure(
        code: "unsupported-text",
        message: "iOS simulators take only characters on a US keyboard.")
    }
    if key.shift { events.append(.keyboard(direction: .down, keyCode: leftShift)) }
    events.append(.keyboard(direction: .down, keyCode: key.usage))
    events.append(.keyboard(direction: .up, keyCode: key.usage))
    if key.shift { events.append(.keyboard(direction: .up, keyCode: leftShift)) }
  }
  return .composite(events)
}

/// Zeros names a turn the way XCTest and UIDeviceOrientation do, after the
/// device: landscape-left has the Home button on the right. FBSimulatorControl
/// names it after the interface, as UIInterfaceOrientation does, so its
/// landscapes are the other way round.
func orientation(_ name: String?) throws -> FBSimulatorHIDDeviceOrientation {
  switch name {
  case "portrait": return .portrait
  case "portrait-upside-down": return .portraitUpsideDown
  case "landscape-left": return .landscapeRight
  case "landscape-right": return .landscapeLeft
  default:
    throw Failure(code: "bad-request", message: "Unknown orientation.")
  }
}

/// The HID event for a request, or nil when it only connects.
func event(for request: Request) throws -> FBSimulatorHIDEvent? {
  switch request.op {
  case "connect":
    return nil
  case "tap":
    return .tapAt(x: try number(request.x, "x"), y: try number(request.y, "y"))
  case "press":
    return .tapAt(
      x: try number(request.x, "x"), y: try number(request.y, "y"),
      duration: try duration(request.seconds))
  case "drag":
    return drag(
      from: CGPoint(x: try number(request.x, "x"), y: try number(request.y, "y")),
      to: CGPoint(x: try number(request.toX, "toX"), y: try number(request.toY, "toY")),
      seconds: try duration(request.seconds))
  case "touch":
    return try touch(request)
  case "text":
    guard let text = request.text, !text.isEmpty else {
      throw Failure(code: "bad-request", message: "text is empty.")
    }
    return try keystrokes(text)
  case "key":
    guard let usage = request.usage, usage > 0, usage < 0x100 else {
      throw Failure(code: "bad-request", message: "usage must be a HID keyboard usage.")
    }
    return .shortKeyPress(usage)
  case "button":
    switch request.button {
    case "home": return .shortButtonPress(.homeButton)
    case "lock": return .shortButtonPress(.lock)
    default: throw Failure(code: "bad-request", message: "Unknown button.")
    }
  case "orientation":
    return .deviceOrientation(try orientation(request.orientation))
  default:
    throw Failure(code: "bad-request", message: "Unknown op.")
  }
}

func perform(_ request: Request, on connections: Connections) async throws {
  // Read the whole request before touching the device.
  guard let event = try event(for: request) else {
    _ = try await connections.hid(request.udid)
    return
  }
  try await connections.send(event, to: request.udid)
}

@main
enum SimulatorHID {
  static func main() async {
    if CommandLine.arguments.dropFirst().contains("--version") {
      print(protocolVersion)
      return
    }
    let output = Output()
    let logger = FBControlCoreLoggerFactory.systemLoggerWriting(
      toStderr: false, withDebugLogging: false)
    let connections: Connections
    do {
      try FBSimulatorControlFrameworkLoader.essentialFrameworks.loadPrivateFrameworks(logger)
      try FBSimulatorControlFrameworkLoader.xcodeFrameworks.loadPrivateFrameworks(logger)
      let configuration = FBSimulatorControlConfiguration(
        deviceSetPath: nil, logger: logger, reporter: nil)
      connections = Connections(
        control: try FBSimulatorControl.withConfiguration(configuration), logger: logger)
    } catch {
      output.send(["ready": false, "error": describe(error)])
      exit(1)
    }
    output.send(["ready": true, "protocol": protocolVersion])

    let lanes = Lanes()
    let fingers = Fingers()
    let decoder = JSONDecoder()
    do {
      for try await line in FileHandle.standardInput.bytes.lines {
        guard let request = try? decoder.decode(Request.self, from: Data(line.utf8)) else {
          FileHandle.standardError.write(Data("unreadable request\n".utf8))
          continue
        }
        fingers.note(request)
        lanes.enqueue(request.udid) {
          do {
            try await perform(request, on: connections)
            output.send(["id": request.id, "ok": true])
          } catch let failure as Failure {
            output.send([
              "id": request.id, "ok": false, "code": failure.code, "error": failure.message,
            ])
          } catch {
            output.send(["id": request.id, "ok": false, "code": "failed", "error": describe(error)])
          }
        }
      }
    } catch {
      FileHandle.standardError.write(Data("stdin failed: \(describe(error))\n".utf8))
    }
    // Zeros closed stdin: it quit or stopped the helper. A finger it left
    // down comes up first.
    for lift in fingers.lifts() {
      lanes.enqueue(lift.udid) { try? await perform(lift, on: connections) }
    }
    await lanes.drain()
    exit(0)
  }
}
