// Posts N synthetic mouse moves around the current pointer (to verify the input lock passes them).
import CoreGraphics
import Foundation
let n = Int(CommandLine.arguments.dropFirst().first ?? "40") ?? 40
let start = CGEvent(source: nil)?.location ?? .zero
for i in 0..<n {
    let p = CGPoint(x: start.x + CGFloat(i % 2 == 0 ? 1 : -1), y: start.y)
    CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
    usleep(10_000)
}
CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: start, mouseButton: .left)?.post(tap: .cghidEventTap)
