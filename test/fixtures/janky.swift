// Fixture for test/why-e2e.mjs: a window with one button. Pressing "Go" slides a bar open over 0.6s, driven frame
// by frame on the main thread, and halfway through calls Model.reload(), which blocks the main thread for
// JANK_MS (default 140; 0 = a clean animation). So the screen shows a freeze whose cause is known exactly.
import AppKit

enum Model {
    /// The culprit the probe's watchdog must name.
    @inline(never) static func reload(ms: Double) {
        let end = CACurrentMediaTime() + ms / 1000
        var x = 0.0
        while CACurrentMediaTime() < end { x += sin(x + 1) }
        if x.isNaN { print(x) }
    }
}

final class Stage: NSView {
    let bar = NSView(frame: NSRect(x: 20, y: 90, width: 20, height: 60))
    var link: CADisplayLink?
    var t0 = 0.0, hung = false
    let jank = Double(ProcessInfo.processInfo.environment["JANK_MS"] ?? "") ?? 140

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = NSColor.black.cgColor
        bar.wantsLayer = true
        bar.layer?.backgroundColor = NSColor.systemOrange.cgColor
        bar.layer?.cornerCurve = .continuous
        bar.layer?.cornerRadius = 14
        addSubview(bar)
        let b = NSButton(title: "Go", target: self, action: #selector(go))
        b.frame = NSRect(x: 20, y: 20, width: 380, height: 40)
        b.setAccessibilityIdentifier("go")
        addSubview(b)
    }
    required init?(coder: NSCoder) { fatalError() }

    @objc func go() {
        link?.invalidate()
        t0 = CACurrentMediaTime(); hung = false
        link = displayLink(target: self, selector: #selector(step))
        link?.add(to: .main, forMode: .common)
    }
    @objc func step() {
        let p = min(1, (CACurrentMediaTime() - t0) / 0.6)
        if p >= 0.5, !hung, jank > 0 { hung = true; Model.reload(ms: jank) }
        let eased = 1 - pow(1 - p, 3)
        CATransaction.begin(); CATransaction.setDisableActions(true)
        bar.frame.size.width = 20 + 360 * eased
        CATransaction.commit()
        if p >= 1 { link?.invalidate(); link = nil }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let win = NSWindow(contentRect: NSRect(x: 160, y: 300, width: 420, height: 170), styleMask: [.titled], backing: .buffered, defer: false)
win.title = "Janky"
win.contentView = Stage(frame: NSRect(x: 0, y: 0, width: 420, height: 170))
win.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)
app.run()
