// Fixture for test/still-e2e.mjs: one window that holds still, with known measurements and known flaws.
// The eye is expected to read them off a single frame (pixels + accessibility frames), nobody asking.
//   text      "Heading Large" 22pt · "Body copy here" 13pt · "Tiny caption" 9pt · "Faint hint" 13pt in #9E9E9E on white (2.68:1)
//   gaps      One / Two / Three / Four in a row: 12, 12, 15pt
//   alignment Upper at x 24, Lower at x 26
//   overlap   Back and Front share 10×20pt
//   cut off   "Runs off the edge" starts 80pt before the window's right edge
//   corners   Circular r18 (circular arc) · Continuous r18 (continuous curvature) · Pill (capsule) · Square
import AppKit
import SwiftUI

struct Box: View {
    let name: String, w: CGFloat, h: CGFloat
    var color = Color(red: 0.1, green: 0.35, blue: 0.85)
    var body: some View {
        Rectangle().fill(color).frame(width: w, height: h)
            .accessibilityElement().accessibilityLabel(name).accessibilityAddTraits(.isImage)
    }
}
struct Shaped<S: Shape>: View {
    let name: String, shape: S
    var body: some View {
        shape.fill(Color(red: 0.85, green: 0.25, blue: 0.3)).frame(width: 90, height: 60)
            .accessibilityElement().accessibilityLabel(name).accessibilityAddTraits(.isImage)
    }
}
extension View {
    func at(_ x: CGFloat, _ y: CGFloat) -> some View { padding(.leading, x).padding(.top, y) }
}

struct Stage: View {
    var body: some View {
        ZStack(alignment: .topLeading) {
            Color.white
            Text("Heading Large").font(.system(size: 22)).foregroundColor(.black).at(24, 20)
            Text("Body copy here").font(.system(size: 13)).foregroundColor(.black).at(24, 60)
            Text("Tiny caption").font(.system(size: 9)).foregroundColor(.black).at(24, 84)
            Text("Faint hint").font(.system(size: 13)).foregroundColor(Color(.sRGB, white: 158 / 255, opacity: 1)).at(24, 104)
            Text("Runs off the edge").font(.system(size: 13)).foregroundColor(.black).fixedSize().at(440, 60)
            Box(name: "One", w: 60, h: 30).at(24, 140)
            Box(name: "Two", w: 60, h: 30).at(96, 140)
            Box(name: "Three", w: 60, h: 30).at(168, 140)
            Box(name: "Four", w: 60, h: 30).at(243, 140)
            Box(name: "Upper", w: 100, h: 24).at(24, 190)
            Box(name: "Lower", w: 100, h: 24).at(26, 224)
            Box(name: "Back", w: 80, h: 40, color: Color(red: 0.2, green: 0.6, blue: 0.3)).at(300, 190)
            Box(name: "Front", w: 80, h: 40, color: Color(red: 0.9, green: 0.6, blue: 0.1)).at(370, 210)
            Shaped(name: "Circular", shape: RoundedRectangle(cornerRadius: 18, style: .circular)).at(24, 270)
            Shaped(name: "Continuous", shape: RoundedRectangle(cornerRadius: 18, style: .continuous)).at(134, 270)
            Shaped(name: "Pill", shape: Capsule(style: .circular)).at(244, 270)
            Shaped(name: "Square", shape: Rectangle()).at(354, 270)
        }
        .frame(width: 520, height: 360, alignment: .topLeading)
    }
}

final class Delegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    func applicationDidFinishLaunching(_ n: Notification) {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 520, height: 360), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "Still"
        window.appearance = NSAppearance(named: .aqua)
        window.contentView = NSHostingView(rootView: Stage())
        if let s = NSScreen.main { window.setFrameTopLeftPoint(NSPoint(x: s.frame.minX + 120, y: s.frame.maxY - 120)) }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
}
let app = NSApplication.shared
let d = Delegate()
app.delegate = d
app.setActivationPolicy(.regular)
app.run()
