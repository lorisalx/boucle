// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "BoucleApp",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "BoucleApp",
            path: "Sources/BoucleApp",
            // Swift 5 language mode: the AVFoundation / ScreenCaptureKit delegate
            // callbacks are not Sendable-clean, and strict Swift 6 concurrency buys
            // us nothing for a local single-user app. Keep it pragmatic.
            swiftSettings: [.swiftLanguageMode(.v5)]
        )
    ]
)
