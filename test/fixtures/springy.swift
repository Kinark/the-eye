// Fixture for test/feel-e2e.mjs: a bar, a puck and a tile, each button moving one of them with a different, known engine.
// The eye is expected to say which engine moved it, and with what numbers, from the screen alone.
//   Spring  CASpringAnimation, mass 1, stiffness 157.91 (response 0.5s), damping 12.57 (damping ratio 0.5)
//   Smooth  CASpringAnimation, critically damped, response 0.4s
//   Ease    CABasicAnimation, easeInEaseOut, 0.35s
//   Lerp    display link, width += (target - width) * 0.12 every frame
//   Slide   the puck's position.x (its size never changes): CASpringAnimation, response 0.45s, damping ratio 0.6
//   Glide   the puck's position.x: CABasicAnimation, easeOut, 0.3s
//   Grow    the tile's bounds.size, both dimensions at once about its centre: CASpringAnimation, response 0.4s, ratio 0.7
//   Drop    the ball is let go 250pt above a floor: constant acceleration 3125pt/s² (lands after 0.4s), each rebound
//           keeps 0.6 of its speed; position computed from the clock every frame (display link). Pressed again: lifted back.
//   Fade    the tile's opacity, 1 ↔ 0.2: CABasicAnimation, easeInEaseOut, 0.4s (nothing moves, it only dims)
// Every press also SAYS two things to accessibility without drawing anything (test/said-e2e.mjs): the status text
// (black on black) becomes "<name> started" in the button's action, and "<name> at 200" is announced 200ms later.
import AppKit

final class Stage: NSView {
    let bar = CALayer(), puck = CALayer(), tile = CALayer(), ball = CALayer()
    var open = false, slid = false, grown = false, dropped = false, faded = false
    var fall: CADisplayLink?
    var fallStart = 0.0
    static let ballTop: CGFloat = 345, ballFloor: CGFloat = 95, gravity = 3125.0, restitution = 0.6
    var link: CADisplayLink?
    var width: CGFloat = 40
    let status = NSTextField(labelWithString: "idle")

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = NSColor.black.cgColor
        bar.backgroundColor = NSColor.systemTeal.cgColor
        bar.cornerCurve = .continuous
        bar.cornerRadius = 14
        bar.anchorPoint = .zero
        bar.frame = CGRect(x: 20, y: 80, width: 40, height: 60)
        layer?.addSublayer(bar)
        puck.backgroundColor = NSColor.systemOrange.cgColor
        puck.cornerCurve = .continuous
        puck.cornerRadius = 12
        puck.anchorPoint = .zero
        puck.frame = CGRect(x: 20, y: 160, width: 50, height: 50)
        layer?.addSublayer(puck)
        tile.backgroundColor = NSColor.systemPink.cgColor
        tile.cornerCurve = .continuous
        tile.cornerRadius = 10
        tile.bounds = CGRect(x: 0, y: 0, width: 60, height: 40)
        tile.position = CGPoint(x: 260, y: 300)
        layer?.addSublayer(tile)
        ball.backgroundColor = NSColor.systemPurple.cgColor
        ball.cornerRadius = 15
        ball.bounds = CGRect(x: 0, y: 0, width: 30, height: 30)
        ball.position = CGPoint(x: 480, y: Stage.ballTop)
        layer?.addSublayer(ball)
        status.textColor = .black
        status.frame = NSRect(x: 8, y: 366, width: 220, height: 18)
        addSubview(status)
        for (i, name) in ["Spring", "Smooth", "Ease", "Lerp", "Slide", "Glide", "Grow", "Drop", "Fade"].enumerated() {
            let b = NSButton(title: name, target: self, action: #selector(go(_:)))
            b.frame = NSRect(x: 6 + i * 57, y: 20, width: 55, height: 40)
            b.setAccessibilityIdentifier(name.lowercased())
            addSubview(b)
        }
    }
    required init?(coder: NSCoder) { fatalError() }

    func spring(_ keyPath: String, response: Double, ratio: Double) -> CASpringAnimation {
        let s = CASpringAnimation(keyPath: keyPath), w = 2 * Double.pi / response
        s.mass = 1; s.stiffness = w * w; s.damping = 2 * ratio * w
        s.duration = s.settlingDuration
        return s
    }
    func run(_ a: CABasicAnimation, on l: CALayer, from: Any, to: Any, set: () -> Void) {
        a.fromValue = from; a.toValue = to
        CATransaction.begin(); CATransaction.setDisableActions(true)
        set()
        CATransaction.commit()
        l.add(a, forKey: "m")
    }

    @objc func go(_ sender: NSButton) {
        let name = sender.title
        status.stringValue = "\(name) started"
        NSAccessibility.post(element: status, notification: .valueChanged)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
            guard let w = self?.window else { return }
            NSAccessibility.post(element: w, notification: .announcementRequested,
                                 userInfo: [.announcement: "\(name) at 200", .priority: NSAccessibilityPriorityLevel.high.rawValue])
        }
        if sender.title == "Drop" {
            dropped.toggle()
            fall?.invalidate(); fall = nil
            if dropped {
                fallStart = CACurrentMediaTime()
                fall = displayLink(target: self, selector: #selector(falling(_:)))
                fall?.add(to: .main, forMode: .common)
            } else {
                let a = CABasicAnimation(keyPath: "position.y"); a.timingFunction = CAMediaTimingFunction(name: .easeOut); a.duration = 0.3
                run(a, on: ball, from: ball.position.y, to: Stage.ballTop) { ball.position.y = Stage.ballTop }
            }
            return
        }
        if sender.title == "Fade" {
            faded.toggle()
            let from = tile.presentation()?.opacity ?? tile.opacity, to: Float = faded ? 0.2 : 1
            let a = CABasicAnimation(keyPath: "opacity"); a.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut); a.duration = 0.4
            run(a, on: tile, from: from, to: to) { tile.opacity = to }
            return
        }
        if sender.title == "Slide" || sender.title == "Glide" {
            slid.toggle()
            let from = puck.presentation()?.position.x ?? puck.position.x, to: CGFloat = slid ? 420 : 20
            let a: CABasicAnimation
            if sender.title == "Slide" { a = spring("position.x", response: 0.45, ratio: 0.6) }
            else { a = CABasicAnimation(keyPath: "position.x"); a.timingFunction = CAMediaTimingFunction(name: .easeOut); a.duration = 0.3 }
            run(a, on: puck, from: from, to: to) { puck.position.x = to }
            return
        }
        if sender.title == "Grow" {
            grown.toggle()
            let from = tile.presentation()?.bounds.size ?? tile.bounds.size
            let to = grown ? CGSize(width: 300, height: 140) : CGSize(width: 60, height: 40)
            run(spring("bounds.size", response: 0.4, ratio: 0.7), on: tile, from: NSValue(size: from), to: NSValue(size: to)) { tile.bounds.size = to }
            return
        }
        open.toggle()
        let from = bar.presentation()?.bounds.width ?? bar.bounds.width, to: CGFloat = open ? 340 : 40
        link?.invalidate(); link = nil
        if sender.title == "Lerp" {
            width = from
            bar.removeAllAnimations()
            link = displayLink(target: self, selector: #selector(step))
            link?.add(to: .main, forMode: .common)
            return
        }
        let a: CABasicAnimation
        switch sender.title {
        case "Spring":
            let s = CASpringAnimation(keyPath: "bounds.size.width")
            s.mass = 1; s.stiffness = 157.91; s.damping = 12.57
            s.duration = s.settlingDuration; a = s
        case "Smooth":
            let s = CASpringAnimation(keyPath: "bounds.size.width")
            let w = 2 * Double.pi / 0.4
            s.mass = 1; s.stiffness = w * w; s.damping = 2 * w
            s.duration = s.settlingDuration; a = s
        default:
            a = CABasicAnimation(keyPath: "bounds.size.width")
            a.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut); a.duration = 0.35
        }
        a.fromValue = from; a.toValue = to
        CATransaction.begin(); CATransaction.setDisableActions(true)
        bar.bounds.size.width = to
        CATransaction.commit()
        bar.add(a, forKey: "w")
    }
    /// Where the ball is `t` seconds after it was let go: parabolas off the floor, each keeping `restitution` of the speed.
    @objc func falling(_ l: CADisplayLink) {
        var t = l.targetTimestamp - fallStart
        let g = Stage.gravity, h = Double(Stage.ballTop - Stage.ballFloor), t1 = (2 * h / g).squareRoot()
        var above = 0.0 // height over the floor
        if t < t1 { above = h - 0.5 * g * t * t } else {
            t -= t1
            var v = g * t1 * Stage.restitution, done = true
            for _ in 0..<40 {
                let flight = 2 * v / g
                if flight < 0.004 { break }
                if t < flight { above = v * t - 0.5 * g * t * t; done = false; break }
                t -= flight; v *= Stage.restitution
            }
            if done { fall?.invalidate(); fall = nil }
        }
        CATransaction.begin(); CATransaction.setDisableActions(true)
        ball.position.y = Stage.ballFloor + CGFloat(above)
        CATransaction.commit()
    }
    @objc func step() {
        let to: CGFloat = open ? 340 : 40
        width += (to - width) * 0.12
        if abs(to - width) < 0.2 { width = to; link?.invalidate(); link = nil }
        CATransaction.begin(); CATransaction.setDisableActions(true)
        bar.bounds.size.width = width
        CATransaction.commit()
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let win = NSWindow(contentRect: NSRect(x: 160, y: 300, width: 520, height: 390), styleMask: [.titled], backing: .buffered, defer: false)
win.title = "Springy"
win.contentView = Stage(frame: NSRect(x: 0, y: 0, width: 520, height: 390))
win.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)
app.run()
