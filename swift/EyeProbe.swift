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
    private let handle: FileHandle
    private let io = DispatchQueue(label: "eye.probe.io")
    private var buf = ""
    private let ids = NSMapTable<CALayer, NSNumber>(keyOptions: [.weakMemory, .objectPointerPersonality], valueOptions: .strongMemory)
    private var labels: [Int: String] = [:]
    private var last: [Int: [Double]] = [:]
    private var nextId = 1
    private var wantedCache: [Int: Bool] = [:]
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
        head += ",\"match\":[\(match.map(json).joined(separator: ","))]}\n"
        buf += head
        let l = screen.displayLink(target: self, selector: #selector(tick(_:)))
        l.add(to: .main, forMode: .common)
        link = l
    }

    func finish(_ reason: String) {
        guard !finished else { return }
        finished = true
        link?.invalidate(); link = nil
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
            record(id, measure(m, p, ctx), changed: &changed, changedIds: &changedIds, present: &present)
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
            record(t.id, measure(m, p, ctx), changed: &changed, changedIds: &changedIds, present: &present)
        }
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

    private func record(_ id: Int, _ g: (CGRect, CGRect?, Float), changed: inout [String], changedIds: inout [Int],
                        present: inout Set<Int>) {
        let (r, s, opacity) = g
        if let rect, !r.intersects(rect), !(s?.intersects(rect) ?? false) { return }
        if !focus, !labelWanted(id) { return }
        present.insert(id)
        let v: [Double] = [r.minX, r.minY, r.width, r.height, Double(opacity),
                           s.map { Double($0.minX) } ?? .nan, s.map { Double($0.minY) } ?? .nan,
                           s.map { Double($0.width) } ?? .nan, s.map { Double($0.height) } ?? .nan]
        if differs(last[id], v) {
            // The first sighting is not motion.
            if last[id] != nil { changedIds.append(id) }
            last[id] = v
            changed.append("[\(id),\(v.map(num).joined(separator: ","))]")
        }
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
