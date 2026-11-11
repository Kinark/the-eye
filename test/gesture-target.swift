// A window that logs every gesture-ish NSEvent it receives as JSON lines (stdout), for test/gestures.mjs.
// Build: swiftc -O test/gesture-target.swift -o /tmp/gesture-target
import AppKit

final class V: NSView {
    override var acceptsFirstResponder: Bool { true }
    func log(_ kind: String, _ e: NSEvent, _ extra: [String: Any] = [:]) {
        // phase/momentumPhase throw for mouse events: only gesture and scroll events have them.
        let phased: Set<NSEvent.EventType> = [.scrollWheel, .magnify, .rotate, .swipe, .smartMagnify, .pressure, .beginGesture, .endGesture]
        var o: [String: Any] = ["kind": kind, "phase": phased.contains(e.type) ? e.phase.rawValue : 0, "momentum": e.type == .scrollWheel ? e.momentumPhase.rawValue : 0]
        for (k, v) in extra { o[k] = v }
        let d = try! JSONSerialization.data(withJSONObject: o)
        print(String(data: d, encoding: .utf8)!)
        fflush(stdout)
    }
    override func magnify(with e: NSEvent) { log("magnify", e, ["m": e.magnification]) }
    override func rotate(with e: NSEvent) { log("rotate", e, ["r": e.rotation]) }
    override func smartMagnify(with e: NSEvent) { log("smartMagnify", e) }
    override func swipe(with e: NSEvent) { log("swipe", e, ["dx": e.deltaX, "dy": e.deltaY]) }
    override func scrollWheel(with e: NSEvent) { log("scroll", e, ["dx": e.scrollingDeltaX, "dy": e.scrollingDeltaY, "precise": e.hasPreciseScrollingDeltas]) }
    override func beginGesture(with e: NSEvent) { log("beginGesture", e) }
    override func endGesture(with e: NSEvent) { log("endGesture", e) }
    override func rightMouseDown(with e: NSEvent) { log("rightMouseDown", e) }
    override func mouseDown(with e: NSEvent) { log("mouseDown", e, ["clicks": e.clickCount]) }
    override func mouseUp(with e: NSEvent) { log("mouseUp", e) }
    override func pressureChange(with e: NSEvent) {
        log("pressure", e, ["stage": e.stage, "p": e.pressure, "st": e.stageTransition, "behavior": e.pressureBehavior.rawValue])
    }
    override func quickLook(with e: NSEvent) { log("quickLook", e) }
    override func acceptsFirstMouse(for e: NSEvent?) -> Bool { true }
    override func draw(_ r: NSRect) { NSColor.systemTeal.setFill(); r.fill() }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
// --at-pointer: a non-activating panel centred on the pointer, so a test never moves the pointer or takes focus.
let atPointer = CommandLine.arguments.contains("--at-pointer")
let m = NSEvent.mouseLocation
let rect = atPointer ? NSRect(x: m.x - 120, y: m.y - 90, width: 240, height: 180) : NSRect(x: 200, y: 200, width: 400, height: 300)
let w: NSWindow = atPointer
    ? NSPanel(contentRect: rect, styleMask: [.nonactivatingPanel, .borderless], backing: .buffered, defer: false)
    : NSWindow(contentRect: rect, styleMask: [.titled], backing: .buffered, defer: false)
if atPointer { w.level = .screenSaver; app.setActivationPolicy(.accessory) }
w.title = "gesture-target"
let v = V()
w.contentView = v
if atPointer { w.orderFrontRegardless() } else { w.makeKeyAndOrderFront(nil) }
w.makeFirstResponder(v)
// Raw app-level view of button events (before any view), to tell "never arrived" from "went to another view".
NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .leftMouseUp]) { e in
    let l = e.locationInWindow
    print("{\"kind\":\"raw\",\"type\":\(e.type.rawValue),\"win\":\(e.windowNumber),\"x\":\(l.x),\"y\":\(l.y),\"phase\":0,\"momentum\":0}")
    fflush(stdout)
    return e
}
// Report the window's global top-left-origin frame so the driver can aim at it.
DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
    let f = w.frame, h = NSScreen.screens[0].frame.height
    print("{\"kind\":\"ready\",\"x\":\(f.minX),\"y\":\(h - f.maxY),\"w\":\(f.width),\"h\":\(f.height),\"pid\":\(getpid()),\"window\":\(w.windowNumber)}")
    fflush(stdout)
    if !atPointer { app.activate(ignoringOtherApps: true) }
}
app.run()
