// Fixture for test/watch.mjs: a window whose label and progress bar change by themselves (no input needed),
// a title that changes once, and a sheet that opens and closes — every event `watch` reports, deterministically.
import AppKit
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let win = NSWindow(contentRect: NSRect(x: 80, y: 80, width: 320, height: 120), styleMask: [.titled], backing: .buffered, defer: false)
win.title = "Ticker"
let label = NSTextField(labelWithString: "step 0")
label.frame = NSRect(x: 20, y: 70, width: 280, height: 24)
let bar = NSProgressIndicator(frame: NSRect(x: 20, y: 30, width: 280, height: 20))
bar.isIndeterminate = false; bar.minValue = 0; bar.maxValue = 4
win.contentView!.addSubview(label); win.contentView!.addSubview(bar)
win.orderFront(nil)
var n = 0
Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { t in
    n += 1
    label.stringValue = n >= 4 ? "Build Succeeded" : "step \(n)"
    bar.doubleValue = Double(min(n, 4))
    NSAccessibility.post(element: label, notification: .valueChanged)
    NSAccessibility.post(element: bar, notification: .valueChanged)
    if n == 5 { win.title = "Ticker — done" }
    if n == 6 {
        let alert = NSAlert(); alert.messageText = "Keep the result?"; alert.addButton(withTitle: "Keep"); alert.addButton(withTitle: "Discard")
        alert.beginSheetModal(for: win) { _ in }
    }
    if n == 9 { win.endSheet(win.attachedSheet!) }
    if n == 60 { t.invalidate(); exit(0) }   // the test kills it long before
}
app.run()
