# AXe release contents

Zeros redistributes the AXe 1.8.0 macOS release archive
(`AXe-macOS-v1.8.0-universal.tar.gz`) from
https://github.com/cameroncooke/AXe for the iOS Simulator tab. The only
change is removing each binary's x86_64 slice with `lipo`.

- `axe`: AXe, MIT, Copyright (c) 2025 Cameron Cooke. See `LICENSE`.
- `Frameworks/FBControlCore.framework`, `FBDeviceControl.framework`,
  `FBSimulatorControl.framework` and `XCTestBootstrap.framework`: idb
  (https://github.com/facebook/idb), MIT, Copyright (c) Meta Platforms, Inc.
  and affiliates. See `LICENSE.idb`.
- `axe` statically links swift-argument-parser 1.5.0
  (https://github.com/apple/swift-argument-parser, revision
  41982a3656a71c768319979febd796c6fd111d5c), Apache-2.0 with the Swift
  Runtime Library Exception. See `LICENSE.swift-argument-parser`.
