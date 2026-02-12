// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "DreamDAW",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(name: "DreamDAW", targets: ["DreamDAW"]),
        .library(name: "DreamDAWModels", targets: ["DreamDAWModels"]),
        .library(name: "DreamDAWEngine", targets: ["DreamDAWEngine"]),
        .library(name: "DreamDAWUI", targets: ["DreamDAWUI"]),
    ],
    targets: [
        // MARK: - Models (Pure data, no framework dependencies)
        .target(
            name: "DreamDAWModels",
            path: "Sources/DreamDAWModels"
        ),

        // MARK: - Audio Engine (AVAudioEngine wrapper)
        .target(
            name: "DreamDAWEngine",
            dependencies: ["DreamDAWModels"],
            path: "Sources/DreamDAWEngine"
        ),

        // MARK: - UI Layer (AppKit + SwiftUI)
        .target(
            name: "DreamDAWUI",
            dependencies: ["DreamDAWModels", "DreamDAWEngine"],
            path: "Sources/DreamDAWUI",
            resources: [
                .process("WaveformShaders.metal")
            ]
        ),

        // MARK: - Main Application
        .executableTarget(
            name: "DreamDAW",
            dependencies: ["DreamDAWModels", "DreamDAWEngine", "DreamDAWUI"],
            path: "Sources/DreamDAW",
            resources: [
                .copy("AppIcon.png")
            ]
        ),

        // MARK: - Tests
        .testTarget(
            name: "DreamDAWModelsTests",
            dependencies: ["DreamDAWModels"],
            path: "Tests/DreamDAWModelsTests"
        ),
        .testTarget(
            name: "DreamDAWEngineTests",
            dependencies: ["DreamDAWEngine", "DreamDAWModels"],
            path: "Tests/DreamDAWEngineTests"
        ),
    ]
)
