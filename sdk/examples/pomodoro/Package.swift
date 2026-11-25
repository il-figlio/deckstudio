// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "pomodoro",
    platforms: [.macOS(.v13)],
    dependencies: [.package(path: "../../swift/DeckKit")],
    targets: [.executableTarget(name: "pomodoro", dependencies: [.product(name: "DeckKit", package: "DeckKit")])]
)
