// swift-tools-version:5.9
// DeckKit: expose a macOS tool to DeckStudio (status file + heartbeat, control token, plugin manifest).
// Plain Foundation, no dependencies.
import PackageDescription
import Foundation

// Command Line Tools without Xcode ship swift-testing's macro plugin but don't load it by default:
// point the test target at it when it is there (Xcode toolchains don't need this).
let cltTestingPlugins = "/Library/Developer/CommandLineTools/usr/lib/swift/host/plugins/testing"
let testSettings: [SwiftSetting] = FileManager.default.fileExists(atPath: cltTestingPlugins + "/libTestingMacros.dylib")
    ? [.unsafeFlags(["-plugin-path", cltTestingPlugins])] : []

let package = Package(
    name: "DeckKit",
    platforms: [.macOS(.v13)],
    products: [.library(name: "DeckKit", targets: ["DeckKit"])],
    targets: [
        .target(name: "DeckKit"),
        .testTarget(name: "DeckKitTests", dependencies: ["DeckKit"], swiftSettings: testSettings),
    ]
)
