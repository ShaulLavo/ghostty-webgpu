import CoreGraphics
import Foundation

let display = CGMainDisplayID()
let modes = CGDisplayCopyAllDisplayModes(display, [kCGDisplayShowDuplicateLowResolutionModes: true] as CFDictionary) as? [CGDisplayMode] ?? []
if CommandLine.arguments.count > 1 {
    let requested = UInt32(CommandLine.arguments[1])!
    guard let mode = modes.first(where: { $0.ioDisplayModeID == requested }) else { fatalError("Display mode absent") }
    let result = CGDisplaySetDisplayMode(display, mode, nil)
    print(result.rawValue)
    exit(result == .success ? 0 : 1)
}
let current = CGDisplayCopyDisplayMode(display)!
let records = modes.map { ["id": Int($0.ioDisplayModeID), "width": $0.width, "height": $0.height, "pixelWidth": $0.pixelWidth, "pixelHeight": $0.pixelHeight] }
let data = try JSONSerialization.data(withJSONObject: ["display": Int(display), "current": Int(current.ioDisplayModeID), "modes": records], options: [.prettyPrinted, .sortedKeys])
print(String(decoding: data, as: UTF8.self))
