// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "vision-ocr",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "vision-ocr", targets: ["VisionOcr"])
    ],
    targets: [
        .executableTarget(name: "VisionOcr"),
        .testTarget(name: "VisionOcrTests", dependencies: ["VisionOcr"])
    ]
)
