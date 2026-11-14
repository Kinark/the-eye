// EyeProbe — loaded INTO the target app (dlopen through a debugger, see src/probe.ts).
//
// On every display refresh (CADisplayLink on the target screen) it walks the layer tree of every
// visible window and logs each layer's PRESENTATION geometry (the in-flight animated values), in
// display-local points, top-left origin — the same space as eye-capture. No pixels involved.
//
// Control is file based so it works inside a sandbox: the-eye writes <dir>/control.json, the probe
// polls it (10 Hz), records to the path it names and reports in <dir>/status_<version>.json.
//
// Output, one JSON object per line (NDJSON):
//   {"k":"S", ...}                                   recording header
//   {"k":"L","id","p","d","w","cls","name","view"}   a layer seen for the first time
//   {"k":"T","n","t","vs","tt","us","v","W","c","g"} one display tick:
//       t  = CACurrentMediaTime() at the walk (mach seconds, same clock as eye-capture)
//       vs/tt = the link's timestamp / targetTimestamp, us = walk cost, v = layers visited
//       W  = [[windowNumber,x,y,w,h]], c = changed layers [[id,x,y,w,h,opacity,sx,sy,sw,sh]]
//            (s* = bounds of the layer's shape path, or of its CAShapeLayer mask; null if none)
//       g  = ids that disappeared (hidden / removed)
//   {"k":"H","t","ms","n","s","ongoing"?}             a main-thread stall: one run-loop turn that began at t and
//       lasted ms; s = n stack samples taken while it lasted, each a list of frame indexes, leaf first
//       (ongoing = still blocked: rewritten once a second, the last line for a t wins)
//   {"k":"F","i","s","b","a"}                        frame i: symbol, image, a = 1 when the image is the app's own
//   {"k":"E","reason"}                               end
import AppKit
import QuartzCore

private struct Ctx {
    let window: NSWindow
    let contentView: NSView
    let rootP: CALayer
    let screenFrame: CGRect
    /// Root-layer space → display-local is a translation plus an optional y flip; resolved once per window per tick
    /// (going through AppKit's convert for every layer was most of the walk's cost).
    var ox: CGFloat = 0, oy: CGFloat = 0, flip = false
}

final class EyeProbeRecording: NSObject {
    let id: String
    let path: String
    let screen: NSScreen
    let rect: CGRect?
    let match: [String]
    let stopAt: Double
    let maxVisits: Int
    let onFinish: (EyeProbeRecording, String) -> Void

    private var link: CADisplayLink?
    private var watchdog: EyeMainWatchdog?
    private let handle: FileHandle
    private let io = DispatchQueue(label: "eye.probe.io")
    private var buf = ""
    private let ids = NSMapTable<CALayer, NSNumber>(keyOptions: [.weakMemory, .objectPointerPersonality], valueOptions: .strongMemory)
    private var labels: [Int: String] = [:]
    private var last: [Int: [Double]] = [:]
    private var nextId = 1
    private var wantedCache: [Int: Bool] = [:]
    private var noted = Set<String>()
    /// Focus mode (match given): a full tree walk only every `rescanEvery` ticks to (re)discover the
    /// labelled layers (match ∪ watch); the ticks in between re-measure just those, so the probe's main-thread
    /// cost stays tiny however big the app's layer tree is. `watch` alone never narrows what is logged.
    let focus: Bool
    private let rescanEvery = 30
    private struct Tracked { weak var layer: CALayer?; let id: Int; let window: Int }
    private var tracked: [Tracked] = []
    private var discovered: [Tracked] = []
    private(set) var ticks = 0
    private(set) var finished = false

    // Live summary (<path>.live.json, rewritten every `liveEvery` s) over the last `liveWindow` s.
    let watch: [String]
    private let liveEvery = 0.25, liveWindow = 0.5
    private var lastLive = 0.0
    private var tickTimes: [Double] = []
    private var walkCosts: [Int] = []
    private var changeTimes: [Int: [Double]] = [:]
    private let t0: Double

    init?(id: String, path: String, screen: NSScreen, rect: CGRect?, match: [String], watch: [String], maxSeconds: Double,
          maxVisits: Int, fullWalk: Bool, onFinish: @escaping (EyeProbeRecording, String) -> Void) {
        FileManager.default.createFile(atPath: path, contents: nil)
        guard let h = FileHandle(forWritingAtPath: path) else { return nil }
        self.id = id; self.path = path; self.screen = screen; self.rect = rect; self.match = match; self.watch = watch
        self.focus = !match.isEmpty && !fullWalk
        self.t0 = CACurrentMediaTime()
        self.stopAt = t0 + maxSeconds; self.maxVisits = maxVisits
        self.onFinish = onFinish; self.handle = h
        super.init()
    }

    private func noteTick(_ t: Double, cost: Int, changedIds: [Int]) {
        tickTimes.append(t); walkCosts.append(cost)
        for id in changedIds { changeTimes[id, default: []].append(t) }
        if t - lastLive >= liveEvery { lastLive = t; writeLive(t) }
    }

    private func writeLive(_ now: Double) {
        let from = now - liveWindow
        if let i = tickTimes.firstIndex(where: { $0 >= from }), i > 0 { tickTimes.removeFirst(i); walkCosts.removeFirst(i) }
        for (k, v) in changeTimes {
            let kept = v.filter { $0 >= from }
            changeTimes[k] = kept.isEmpty ? nil : kept
        }
        func ticksBetween(_ a: Double, _ b: Double) -> Int { tickTimes.filter { $0 >= a - 1e-6 && $0 <= b + 1e-6 }.count }
        func entry(_ id: Int) -> [String: Any] {
            var e: [String: Any] = ["id": id, "label": labels[id] ?? ""]
            if let v = last[id] {
                e["rect"] = Array(v[0..<4]).map(round3); e["opacity"] = round3(v[4])
                if !v[5].isNaN { e["shape"] = Array(v[5..<9]).map(round3) }
            } else { e["gone"] = true }
            let ts = changeTimes[id] ?? []
            e["updates"] = ts.count
            if ts.count >= 2 {
                var gap = 0.0
                for i in 1..<ts.count { gap = max(gap, ts[i] - ts[i - 1]) }
                let span = ticksBetween(ts.first!, ts.last!)
                e["frames_in_span"] = span
                e["coverage"] = round3(Double(ts.count) / Double(max(span, 1)))
                e["max_gap_ms"] = round3(gap * 1000)
            }
            return e
        }
        let moving = changeTimes.keys.sorted { (changeTimes[$0]?.count ?? 0) > (changeTimes[$1]?.count ?? 0) }
        let watched = watch.isEmpty ? [] : labels.filter { _, l in watch.contains { l.localizedCaseInsensitiveContains($0) } }
            .keys.filter { last[$0] != nil }.sorted()
        let costs = walkCosts.sorted()
        let o: [String: Any] = [
            "id": id, "t_mach": now, "t": round3(now - t0), "window_s": liveWindow, "ticks_total": ticks,
            "ticks": tickTimes.count,
            "tick_hz": round3(Double(tickTimes.count) / liveWindow),
            "walk_us_p50": costs.isEmpty ? 0 : costs[costs.count / 2],
            "walk_us_max": costs.last ?? 0,
            "layers_tracked": last.count,
            "stalls": watchdog?.count ?? 0, "stall_worst_ms": round3(watchdog?.worstMs ?? 0),
            "moving_count": moving.count,
            "moving": moving.prefix(16).map(entry),
            "watched": watched.prefix(24).map(entry),
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: o) else { return }
        let url = URL(fileURLWithPath: path + ".live.json")
        io.async { try? data.write(to: url, options: .atomic) }
    }

    func start() {
        let sf = screen.frame
        let num = (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.intValue ?? 0
        var head = "{\"k\":\"S\",\"id\":\(json(id)),\"pid\":\(getpid()),\"t\":\(CACurrentMediaTime()),\"display\":\(num)"
        head += ",\"screen\":[\(sf.minX),\(sf.minY),\(sf.width),\(sf.height)],\"scale\":\(screen.backingScaleFactor)"
        head += ",\"hz\":\(screen.maximumFramesPerSecond),\"focus\":\(focus)"
        if let r = rect { head += ",\"rect\":[\(r.minX),\(r.minY),\(r.width),\(r.height)]" }
        // A turn of the main run loop longer than a frame and a quarter is a stall worth explaining.
        let threshold = max(0.008, 1.25 / Double(max(screen.maximumFramesPerSecond, 30)))
        head += ",\"stall_ms\":\(String(format: "%.2f", threshold * 1000)),\"stacks\":\(EyeMainWatchdog.stacks)"
        head += ",\"match\":[\(match.map(json).joined(separator: ","))]}\n"
        buf += head
        let h = handle, q = io
        watchdog = EyeMainWatchdog(threshold: threshold) { line in
            let data = Data(line.utf8)
            q.async { try? h.write(contentsOf: data) }
        }
        let l = screen.displayLink(target: self, selector: #selector(tick(_:)))
        l.add(to: .main, forMode: .common)
        link = l
    }

    func finish(_ reason: String) {
        guard !finished else { return }
        finished = true
        link?.invalidate(); link = nil
        watchdog?.stop(); watchdog = nil
        buf += "{\"k\":\"E\",\"reason\":\(json(reason)),\"ticks\":\(ticks),\"t\":\(CACurrentMediaTime())}\n"
        flush()
        io.sync { try? handle.close() }
        onFinish(self, reason)
    }

    @objc private func tick(_ l: CADisplayLink) {
        let t0 = CACurrentMediaTime()
        if t0 > stopAt { finish("max_seconds"); return }
        ticks += 1
        let sf = screen.frame
        var changed: [String] = []
        var changedIds: [Int] = []
        var present = Set<Int>()
        var visits = 0
        var wins: [String] = []
        let rescan = !focus || ticks % rescanEvery == 1
        var ctxs: [Int: Ctx] = [:]
        if rescan { discovered.removeAll(keepingCapacity: true) }
        for w in NSApp.windows where w.isVisible && w.frame.intersects(sf) {
            guard let cv = w.contentView, let root = cv.layer else { continue }
            let wf = w.frame
            wins.append("[\(w.windowNumber),\(r2(wf.minX - sf.minX)),\(r2(sf.maxY - wf.maxY)),\(r2(wf.width)),\(r2(wf.height))]")
            var ctx = Ctx(window: w, contentView: cv, rootP: root.presentation() ?? root, screenFrame: sf)
            let a = slowToDisplay(.zero, ctx), b = slowToDisplay(CGRect(x: 0, y: 100, width: 0, height: 0), ctx)
            ctx.ox = a.minX; ctx.oy = a.minY; ctx.flip = b.minY < a.minY
            ctxs[w.windowNumber] = ctx
            if rescan {
                walk(root, pres: ctx.rootP, parent: 0, depth: 0, ctx: ctx, changed: &changed, changedIds: &changedIds,
                     present: &present, visits: &visits)
            }
        }
        if focus {
            if rescan { tracked = discovered }
            else { fastTick(ctxs: ctxs, changed: &changed, changedIds: &changedIds, present: &present, visits: &visits) }
        }
        var gone: [Int] = []
        for k in last.keys where !present.contains(k) { gone.append(k) }
        for k in gone { last[k] = nil }
        let us = Int((CACurrentMediaTime() - t0) * 1e6)
        var line = "{\"k\":\"T\",\"n\":\(ticks),\"t\":\(t0),\"vs\":\(l.timestamp),\"tt\":\(l.targetTimestamp),\"us\":\(us),\"v\":\(visits)"
        line += ",\"W\":[\(wins.joined(separator: ","))]"
        if !changed.isEmpty { line += ",\"c\":[\(changed.joined(separator: ","))]" }
        if !gone.isEmpty { line += ",\"g\":[\(gone.map(String.init).joined(separator: ","))]" }
        buf += line + "}\n"
        if buf.utf8.count > 128 * 1024 || ticks % 12 == 0 { flush() }
        noteTick(t0, cost: us, changedIds: changedIds)
    }

    private func walk(_ m: CALayer, pres p: CALayer, parent: Int, depth: Int, ctx: Ctx,
                      changed: inout [String], changedIds: inout [Int], present: inout Set<Int>, visits: inout Int) {
        if m.isHidden || visits >= maxVisits { return }
        visits += 1
        let id = layerId(m, parent: parent, depth: depth, window: ctx.window.windowNumber)
        // Focus mode: only labelled-in layers are measured (the label test is a cached lookup; geometry is not).
        if !focus || labelWanted(id) {
            if focus { discovered.append(Tracked(layer: m, id: id, window: ctx.window.windowNumber)) }
            if record(id, measure(m, p, ctx), changed: &changed, changedIds: &changedIds, present: &present) { noteAnimations(m, id) }
        }
        guard let subs = m.sublayers else { return }
        for sub in subs {
            guard let sp = sub.presentation() else { continue } // not committed yet: not on screen
            walk(sub, pres: sp, parent: id, depth: depth + 1, ctx: ctx, changed: &changed, changedIds: &changedIds,
                 present: &present, visits: &visits)
        }
    }

    /// Focus-mode tick: re-measure only the layers the last discovery walk found, straight from their refs.
    private func fastTick(ctxs: [Int: Ctx], changed: inout [String], changedIds: inout [Int], present: inout Set<Int>,
                          visits: inout Int) {
        for t in tracked {
            guard let m = t.layer, let ctx = ctxs[t.window], let p = m.presentation() else { continue }
            // Still attached to that window's tree and not hidden anywhere up the chain?
            var a: CALayer? = m, attached = false, hidden = false
            while let l = a {
                if l.isHidden { hidden = true; break }
                if l === ctx.contentView.layer { attached = true; break }
                a = l.superlayer
            }
            guard attached, !hidden else { continue }
            visits += 1
            if record(t.id, measure(m, p, ctx), changed: &changed, changedIds: &changedIds, present: &present) { noteAnimations(m, t.id) }
        }
    }

    /// What the app itself asked for: the Core Animation animations attached to a layer that is changing right now,
    /// with their declared parameters. Logged once per animation ("A" line). Only layers whose geometry or opacity
    /// just changed are asked, so a still tree costs nothing. (An app that drives values itself every frame, as
    /// SwiftUI does on macOS, attaches none: then only the measured values speak.)
    private func noteAnimations(_ m: CALayer, _ id: Int) {
        guard let keys = m.animationKeys(), !keys.isEmpty else { return }
        for key in keys {
            guard let a = m.animation(forKey: key) else { continue }
            let seen = "\(id)|\(key)|\(a.beginTime)|\(a.duration)"
            if noted.contains(seen) { continue }
            if noted.count > 4096 { noted.removeAll() }
            noted.insert(seen)
            var o = describe(a)
            o["k"] = "A"; o["id"] = id; o["key"] = key; o["t"] = fin(CACurrentMediaTime())
            guard JSONSerialization.isValidJSONObject(o), let d = try? JSONSerialization.data(withJSONObject: o),
                  let line = String(data: d, encoding: .utf8) else { continue }
            buf += line + "\n"
        }
    }

    private func fin(_ d: Double) -> Any { d.isFinite ? d : NSNull() }

    private func animValue(_ v: Any?) -> Any {
        guard let v else { return NSNull() }
        if let n = v as? NSNumber { return fin(n.doubleValue) }
        if let nv = v as? NSValue { return String(String(describing: nv).prefix(80)) }
        return NSNull()
    }

    private func describe(_ a: CAAnimation) -> [String: Any] {
        var o: [String: Any] = ["cls": String(describing: type(of: a)), "dur": fin(a.duration), "begin": fin(a.beginTime),
                                "speed": fin(Double(a.speed))]
        if a.repeatCount != 0 { o["repeat"] = a.repeatCount.isFinite ? Double(a.repeatCount) as Any : "forever" }
        if a.autoreverses { o["autoreverses"] = true }
        if let tf = a.timingFunction {
            var c1: [Float] = [0, 0], c2: [Float] = [0, 0]
            tf.getControlPoint(at: 1, values: &c1); tf.getControlPoint(at: 2, values: &c2)
            o["tf"] = [fin(Double(c1[0])), fin(Double(c1[1])), fin(Double(c2[0])), fin(Double(c2[1]))]
        }
        if let pa = a as? CAPropertyAnimation {
            o["kp"] = pa.keyPath ?? NSNull()
            if pa.isAdditive { o["additive"] = true }
        }
        if let b = a as? CABasicAnimation {
            o["from"] = animValue(b.fromValue); o["to"] = animValue(b.toValue)
            if b.byValue != nil { o["by"] = animValue(b.byValue) }
        }
        if let s = a as? CASpringAnimation {
            o["mass"] = fin(Double(s.mass)); o["stiffness"] = fin(Double(s.stiffness)); o["damping"] = fin(Double(s.damping))
            o["v0"] = fin(Double(s.initialVelocity)); o["settle"] = fin(s.settlingDuration)
        }
        if let k = a as? CAKeyframeAnimation {
            o["values"] = k.values?.count ?? 0
            if let kt = k.keyTimes { o["keyTimes"] = kt.map { fin($0.doubleValue) } }
            o["mode"] = k.calculationMode.rawValue
            if k.path != nil { o["path"] = true }
        }
        if let g = a as? CAAnimationGroup { o["group"] = (g.animations ?? []).prefix(12).map { describe($0) } }
        if let t = a as? CATransition { o["transition"] = t.type.rawValue }
        return o
    }

    private func measure(_ m: CALayer, _ p: CALayer, _ ctx: Ctx) -> (CGRect, CGRect?, Float) {
        let r = toDisplay(p.convert(p.bounds, to: ctx.rootP), ctx)
        var s: CGRect?
        if let sl = p as? CAShapeLayer, let path = sl.path, !path.isEmpty {
            s = toDisplay(p.convert(path.boundingBoxOfPath, to: ctx.rootP), ctx)
        } else if let mk = m.mask {
            let mp = mk.presentation() ?? mk
            if let sl = mp as? CAShapeLayer, let path = sl.path, !path.isEmpty {
                let bb = path.boundingBoxOfPath.offsetBy(dx: mp.frame.minX, dy: mp.frame.minY)
                s = toDisplay(p.convert(bb, to: ctx.rootP), ctx)
            }
        }
        return (r, s, p.opacity)
    }

    /// True when this layer's values changed since the last tick (it is in motion, not merely first seen).
    @discardableResult
    private func record(_ id: Int, _ g: (CGRect, CGRect?, Float), changed: inout [String], changedIds: inout [Int],
                        present: inout Set<Int>) -> Bool {
        let (r, s, opacity) = g
        if let rect, !r.intersects(rect), !(s?.intersects(rect) ?? false) { return false }
        if !focus, !labelWanted(id) { return false }
        present.insert(id)
        let v: [Double] = [r.minX, r.minY, r.width, r.height, Double(opacity),
                           s.map { Double($0.minX) } ?? .nan, s.map { Double($0.minY) } ?? .nan,
                           s.map { Double($0.width) } ?? .nan, s.map { Double($0.height) } ?? .nan]
        if differs(last[id], v) {
            // The first sighting is not motion.
            let moved = last[id] != nil
            if moved { changedIds.append(id) }
            last[id] = v
            changed.append("[\(id),\(v.map(num).joined(separator: ","))]")
            return moved
        }
        return false
    }

    /// Label filter (cached per layer id): match ∪ watch in focus mode, match alone otherwise (empty = all).
    private func labelWanted(_ id: Int) -> Bool {
        if let c = wantedCache[id] { return c }
        let keys = focus ? match + watch : match
        let label = labels[id] ?? ""
        let ok = keys.isEmpty || keys.contains { label.localizedCaseInsensitiveContains($0) }
        wantedCache[id] = ok
        return ok
    }

    /// Root-layer space (= the content view's own space) → display-local points, top-left origin.
    private func toDisplay(_ r: CGRect, _ ctx: Ctx) -> CGRect {
        CGRect(x: ctx.ox + r.minX, y: ctx.flip ? ctx.oy - r.maxY : ctx.oy + r.minY, width: r.width, height: r.height)
    }

    private func slowToDisplay(_ r: CGRect, _ ctx: Ctx) -> CGRect {
        let inWindow = ctx.contentView.convert(r, to: nil)
        let g = ctx.window.convertToScreen(inWindow)
        return CGRect(x: g.minX - ctx.screenFrame.minX, y: ctx.screenFrame.maxY - g.maxY, width: g.width, height: g.height)
    }

    private func layerId(_ m: CALayer, parent: Int, depth: Int, window: Int) -> Int {
        if let n = ids.object(forKey: m) { return n.intValue }
        let id = nextId; nextId += 1
        ids.setObject(NSNumber(value: id), forKey: m)
        let cls = String(describing: type(of: m))
        let view = (m.delegate as? NSView).map { String(String(describing: type(of: $0)).prefix(120)) }
        // AppKit names view-backing layers after the view's mangled class: noise next to `view`.
        let name = m.name.flatMap { $0.hasPrefix("_Tt") || $0.hasPrefix("$s") ? nil : String($0.prefix(120)) }
        labels[id] = [cls, view ?? "", name ?? ""].joined(separator: " ")
        buf += "{\"k\":\"L\",\"id\":\(id),\"p\":\(parent),\"d\":\(depth),\"w\":\(window),\"cls\":\(json(cls))"
        buf += ",\"view\":\(view.map(json) ?? "null"),\"name\":\(name.map(json) ?? "null")}\n"
        return id
    }

    private func differs(_ a: [Double]?, _ b: [Double]) -> Bool {
        guard let a else { return true }
        for i in 0..<b.count {
            let x = a[i], y = b[i]
            if x.isNaN != y.isNaN { return true }
            if !x.isNaN, abs(x - y) > 0.004 { return true }
        }
        return false
    }

    private func flush() {
        guard !buf.isEmpty else { return }
        let data = Data(buf.utf8); buf = ""
        let h = handle
        io.async { try? h.write(contentsOf: data) }
    }
}

private func r2(_ d: CGFloat) -> String { num(Double(d)) }
private func round3(_ d: Double) -> Double { d.isFinite ? (d * 1000).rounded() / 1000 : 0 }
private func num(_ d: Double) -> String {
    guard d.isFinite else { return "null" }
    let v = (d * 1000).rounded() / 1000
    // Int(_:) traps beyond ±2^63, and some layers report effectively infinite bounds (~1e308).
    return v == v.rounded() && abs(v) < 1e15 ? String(Int(v)) : String(v)
}
private func json(_ s: String) -> String {
    let data = try? JSONSerialization.data(withJSONObject: [s], options: [])
    let arr = data.flatMap { String(data: $0, encoding: .utf8) } ?? "[\"\"]"
    return String(arr.dropFirst().dropLast())
}

@_silgen_name("swift_demangle")
private func eyeDemangle(_ name: UnsafePointer<CChar>?, _ length: UInt, _ out: UnsafeMutablePointer<CChar>?,
                         _ outLength: UnsafeMutablePointer<UInt>?, _ flags: UInt32) -> UnsafeMutablePointer<CChar>?

/// libc++abi's demangler, looked up at run time (every AppKit process has it loaded; the probe does not link it).
private typealias CxxDemangle = @convention(c) (UnsafePointer<CChar>?, UnsafeMutablePointer<CChar>?, UnsafeMutablePointer<Int>?,
                                                UnsafeMutablePointer<Int32>?) -> UnsafeMutablePointer<CChar>?
private let cxxDemangle: CxxDemangle? = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "__cxa_demangle").map { unsafeBitCast($0, to: CxxDemangle.self) }
private func eyeCxxDemangle(_ name: UnsafePointer<CChar>?, _ out: UnsafeMutablePointer<CChar>?, _ length: UnsafeMutablePointer<Int>?,
                            _ status: UnsafeMutablePointer<Int32>?) -> UnsafeMutablePointer<CChar>? {
    cxxDemangle?(name, out, length, status)
}

/// WHY a frame was late, measured where it happens. A run-loop observer on the main thread marks when each turn
/// starts and ends; a watcher thread notices a turn that outlives `threshold` (a bit over one display frame) and,
/// while it lasts, samples the main thread's stack (suspend → walk frame pointers → resume: a few microseconds).
/// A healthy app costs nothing but the two observer callbacks per turn. Each stall becomes one "H" line, with
/// its frames in "F" lines, on the same mach clock as the ticks and as eye-capture's frames.
final class EyeMainWatchdog {
    static let depth = 48, maxSamples = 64
    private let thread: thread_t
    private let lo: UInt, hi: UInt
    /// [0] start of the current run-loop turn (0 = waiting) · [1] start and [2] end of the last turn over the
    /// threshold. Written by the main thread, read by the watcher: word-sized stores, no lock to deadlock on.
    private let slots = UnsafeMutablePointer<Double>.allocate(capacity: 3)
    private let pcs = UnsafeMutablePointer<UInt>.allocate(capacity: EyeMainWatchdog.depth)
    private var observer: CFRunLoopObserver?
    private var running = true
    private let done = DispatchSemaphore(value: 0)
    private let threshold: Double
    private let emit: (String) -> Void
    private var frameIndex: [UInt: Int] = [:]
    private(set) var count = 0
    private(set) var worstMs = 0.0
    static var stacks: Bool {
        #if arch(arm64)
        return true
        #else
        return false
        #endif
    }

    /// Must be created on the main thread (it is the thread it watches).
    init(threshold: Double, emit: @escaping (String) -> Void) {
        let me = pthread_self()
        thread = pthread_mach_thread_np(me)
        hi = UInt(bitPattern: pthread_get_stackaddr_np(me))
        lo = hi - UInt(pthread_get_stacksize_np(me))
        self.threshold = threshold; self.emit = emit
        slots.initialize(repeating: 0, count: 3)
        let s = slots, thr = threshold
        let acts: CFRunLoopActivity = [.entry, .afterWaiting, .beforeWaiting, .exit]
        observer = CFRunLoopObserverCreateWithHandler(nil, acts.rawValue, true, 0) { _, a in
            let now = CACurrentMediaTime()
            if a == .beforeWaiting {
                let since = s[0]
                if since > 0, now - since >= thr { s[2] = now; s[1] = since }
                s[0] = 0
            } else { s[0] = now }
        }
        CFRunLoopAddObserver(CFRunLoopGetMain(), observer, .commonModes)
        let t = Thread { [unowned self] in self.watch() }
        t.name = "the-eye main-thread watchdog"; t.qualityOfService = .userInteractive
        t.start()
    }

    /// Main thread. Waits for the watcher to write out a stall in progress.
    func stop() {
        if let o = observer { CFRunLoopRemoveObserver(CFRunLoopGetMain(), o, .commonModes) }
        observer = nil; running = false
        _ = done.wait(timeout: .now() + 0.2)
    }

    private func watch() {
        var since = 0.0, samples: [[UInt]] = [], polls = 0, lastReport = 0.0, logged = 0.0
        func close(ongoing: Bool) {
            guard since > 0 else { return }
            let now = CACurrentMediaTime()
            let end = slots[1] == since ? slots[2] : now
            if !ongoing || now - lastReport >= 1 { lastReport = now; report(since, end, samples, ongoing) }
            if !ongoing { logged = since; since = 0; samples = []; polls = 0 }
        }
        while running {
            usleep(3000)
            let s = slots[0], now = CACurrentMediaTime()
            if since > 0, s != since { close(ongoing: false) }
            // A turn that crossed the threshold and ended between two polls: no time to sample it, still a stall.
            let ended = slots[1]
            if ended != logged, ended != since { logged = ended; report(ended, slots[2], [], false) }
            guard s > 0, now - s >= threshold else { continue }
            if since == 0 { lastReport = now }
            since = s; polls += 1
            // Dense at first (the first 100ms tell most of the story), then sparser so a long hang stays cheap.
            if samples.count < EyeMainWatchdog.maxSamples, samples.count < 32 || polls % 8 == 0 {
                let n = sample()
                if n > 0 { samples.append(Array(UnsafeBufferPointer(start: pcs, count: n))) }
            }
            close(ongoing: true)
        }
        close(ongoing: false)
        done.signal()
    }

    /// The main thread's call stack, leaf first, into `pcs`. Nothing here may allocate or lock: the main thread is
    /// suspended and may hold the allocator's lock.
    private func sample() -> Int {
        #if arch(arm64)
        guard thread_suspend(thread) == KERN_SUCCESS else { return 0 }
        var st = arm_thread_state64_t()
        var cnt = mach_msg_type_number_t(MemoryLayout<arm_thread_state64_t>.size / MemoryLayout<natural_t>.size)
        let kr = withUnsafeMutablePointer(to: &st) {
            $0.withMemoryRebound(to: natural_t.self, capacity: Int(cnt)) { thread_get_state(thread, ARM_THREAD_STATE64, $0, &cnt) }
        }
        var n = 0
        if kr == KERN_SUCCESS {
            let mask: UInt = 0x0000_7FFF_FFFF_FFFF // drop pointer-authentication bits
            pcs[0] = UInt(st.__pc) & mask; n = 1
            var fp = UInt(st.__fp)
            while n < EyeMainWatchdog.depth, fp >= lo, fp &+ 16 <= hi, fp & 7 == 0 {
                let rec = UnsafePointer<UInt>(bitPattern: fp)!
                let ret = rec[1] & mask
                if ret < 4096 { break }
                pcs[n] = ret; n += 1
                let next = rec[0]
                if next <= fp { break }
                fp = next
            }
        }
        thread_resume(thread)
        return n
        #else
        return 0
        #endif
    }

    private func frame(_ pc: UInt, leaf: Bool) -> Int {
        if let i = frameIndex[pc] { return i }
        let i = frameIndex.count
        frameIndex[pc] = i
        var info = Dl_info()
        var sym = String(format: "0x%lx", pc), image = "?", own = false
        // A return address points just past the call: look one byte back to stay inside the caller.
        if dladdr(UnsafeRawPointer(bitPattern: leaf ? pc : pc - 1), &info) != 0 {
            if let f = info.dli_fname {
                let path = String(cString: f)
                image = (path as NSString).lastPathComponent
                own = !(path.hasPrefix("/System/") || path.hasPrefix("/usr/lib/") || path.hasPrefix("/Library/Apple/")) && !image.hasPrefix("EyeProbe_")
            }
            if let s = info.dli_sname {
                let raw = String(cString: s)
                var status: Int32 = 0
                if let d = eyeDemangle(s, UInt(strlen(s)), nil, nil, 0) { sym = String(cString: d); free(d) }
                else if raw.hasPrefix("_Z"), let d = eyeCxxDemangle(s, nil, nil, &status), status == 0 { sym = String(cString: d); free(d) }
                else { sym = raw }
            } else if let base = info.dli_fbase { sym = String(format: "%@+0x%lx", image, pc - UInt(bitPattern: base)) }
        }
        emit("{\"k\":\"F\",\"i\":\(i),\"s\":\(json(String(sym.prefix(240)))),\"b\":\(json(image)),\"a\":\(own ? 1 : 0)}\n")
        return i
    }

    private func report(_ since: Double, _ end: Double, _ samples: [[UInt]], _ ongoing: Bool) {
        let ms = (end - since) * 1000
        if !ongoing { count += 1; worstMs = max(worstMs, ms) }
        let st = samples.map { s in "[" + s.enumerated().map { String(frame($0.element, leaf: $0.offset == 0)) }.joined(separator: ",") + "]" }
        emit("{\"k\":\"H\",\"t\":\(since),\"ms\":\(num(ms)),\"n\":\(samples.count)\(ongoing ? ",\"ongoing\":true" : ""),\"s\":[\(st.joined(separator: ","))]}\n")
    }
}

final class EyeProbeCore: NSObject {
    static var shared: EyeProbeCore?
    let dir: URL
    let version: String
    private var watch: Timer?
    private var lastControl = Data()
    private var rec: EyeProbeRecording?
    private var lastStatus = 0.0
    private var lastResult: [String: Any] = [:]

    init(dir: URL, version: String) {
        self.dir = dir; self.version = version
        super.init()
    }

    func begin() {
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        // Ignore a control file left from before this probe was loaded.
        lastControl = (try? Data(contentsOf: dir.appendingPathComponent("control.json"))) ?? Data()
        writeStatus()
        let t = Timer(timeInterval: 0.1, repeats: true) { [weak self] _ in self?.poll() }
        RunLoop.main.add(t, forMode: .common)
        watch = t
    }

    private func poll() {
        let now = CACurrentMediaTime()
        if now - lastStatus > 0.5 { writeStatus() }
        guard let data = try? Data(contentsOf: dir.appendingPathComponent("control.json")), data != lastControl else { return }
        lastControl = data
        guard let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
        // A newer probe loaded into the same process retires this one.
        if o["cmd"] as? String == "retire", let keep = o["keep"] as? String, keep != version {
            rec?.finish("retired")
            watch?.invalidate(); watch = nil
            try? FileManager.default.removeItem(at: dir.appendingPathComponent("status_\(version).json"))
            return
        }
        guard (o["version"] as? String) == version else { return }
        switch o["cmd"] as? String {
        case "start": start(o)
        case "stop": rec?.finish("stopped")
        default: break
        }
        writeStatus()
    }

    private func start(_ o: [String: Any]) {
        rec?.finish("replaced")
        let id = o["id"] as? String ?? UUID().uuidString
        let path = o["out"] as? String ?? dir.appendingPathComponent("\(id).ndjson").path
        let display = (o["display"] as? NSNumber)?.intValue
        let screen = NSScreen.screens.first {
            (($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.intValue) == display
        } ?? NSScreen.screens.first
        guard let screen else { lastResult = ["error": "no screen"]; return }
        var rect: CGRect?
        if let a = o["rect"] as? [NSNumber], a.count == 4 {
            rect = CGRect(x: a[0].doubleValue, y: a[1].doubleValue, width: a[2].doubleValue, height: a[3].doubleValue)
        }
        let r = EyeProbeRecording(
            id: id, path: path, screen: screen, rect: rect, match: o["match"] as? [String] ?? [],
            watch: o["watch"] as? [String] ?? [],
            maxSeconds: (o["max_seconds"] as? NSNumber)?.doubleValue ?? 60,
            maxVisits: (o["max_layers"] as? NSNumber)?.intValue ?? 6000,
            fullWalk: (o["full_walk"] as? Bool) ?? false
        ) { [weak self] r, reason in
            guard let self else { return }
            self.lastResult = ["id": r.id, "path": r.path, "reason": reason, "ticks": r.ticks]
            if self.rec === r { self.rec = nil }
            self.writeStatus()
        }
        guard let r else { lastResult = ["error": "cannot write \(path)"]; return }
        rec = r
        r.start()
    }

    private func writeStatus() {
        lastStatus = CACurrentMediaTime()
        var s: [String: Any] = ["version": version, "pid": Int(getpid()), "t": lastStatus,
                                "state": rec == nil ? "idle" : "recording", "last": lastResult]
        if let rec { s["id"] = rec.id; s["path"] = rec.path; s["ticks"] = rec.ticks }
        guard let data = try? JSONSerialization.data(withJSONObject: s) else { return }
        // Per version: probes of different versions can be loaded in the same process at once.
        try? data.write(to: dir.appendingPathComponent("status_\(version).json"), options: .atomic)
    }
}

/// Entry point called by the debugger right after dlopen. Returns at once; setup runs on the main
/// queue once the process resumes (the debugger may have stopped it on any thread).
@_cdecl("eye_probe_init")
public func eyeProbeInit(_ dir: UnsafePointer<CChar>, _ version: UnsafePointer<CChar>) -> Int32 {
    let d = URL(fileURLWithPath: String(cString: dir)), v = String(cString: version)
    DispatchQueue.main.async {
        guard EyeProbeCore.shared == nil else { return }
        let core = EyeProbeCore(dir: d, version: v)
        EyeProbeCore.shared = core
        core.begin()
    }
    return 1
}
