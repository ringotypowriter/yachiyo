// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "YachiyoChatUI",
    defaultLocalization: "en",
    platforms: [.iOS(.v17)],
    products: [
        .library(name: "YachiyoChatUI", targets: ["YachiyoChatUI"]),
        .library(name: "YachiyoMaterial", targets: ["YachiyoMaterial"]),
    ],
    // Pinned to the majors the forked LanguageModelChatUI view layer was written against;
    // ListViewKit 2+ and Litext 2+ replaced the APIs the fork uses.
    dependencies: [
        .package(url: "https://github.com/Lakr233/MarkdownView", exact: "3.9.1"),
        .package(url: "https://github.com/Lakr233/ListViewKit", exact: "1.2.0"),
        .package(url: "https://github.com/Lakr233/Litext", exact: "1.3.0"),
        .package(url: "https://github.com/apple/swift-collections", exact: "1.6.0"),
    ],
    targets: [
        // Glass, fallbacks, and design tokens. The only place (with the forked ChatInputView)
        // allowed to branch on iOS 26 availability; `pnpm run ios:check` enforces this.
        .target(name: "YachiyoMaterial"),
        .target(
            name: "YachiyoChatUI",
            dependencies: [
                "YachiyoMaterial",
                .product(name: "MarkdownView", package: "MarkdownView"),
                .product(name: "ListViewKit", package: "ListViewKit"),
                .product(name: "Litext", package: "Litext"),
                .product(name: "OrderedCollections", package: "swift-collections"),
            ],
            resources: [.process("Resources")]
        ),
        .testTarget(name: "YachiyoChatUITests", dependencies: ["YachiyoChatUI", "YachiyoMaterial"]),
    ],
    swiftLanguageModes: [.v5]
)
