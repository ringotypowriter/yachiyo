// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "YachiyoRemoteKit",
    // macOS is listed so `swift test` runs on a Mac host (CI and local) without a simulator.
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "YachiyoRemoteKit", targets: ["YachiyoRemoteKit"]),
    ],
    targets: [
        .target(name: "YachiyoRemoteKit"),
        .testTarget(name: "YachiyoRemoteKitTests", dependencies: ["YachiyoRemoteKit"]),
    ],
    swiftLanguageModes: [.v5]
)
