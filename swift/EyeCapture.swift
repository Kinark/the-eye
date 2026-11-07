// eye-capture — native half of the-eye MCP.
//
// Subcommands (all output is JSON on stdout unless noted):
//   displays
//   capture  --rect x,y,w,h [--display ID] [--seconds N] [--fps 120] --out run.csv
//            [--keyframes-dir DIR --keyframe-ms 100] [--step N]
//            Streams one CSV row per ScreenCaptureKit frame callback until --seconds elapse or
//            SIGINT/SIGTERM, then writes run.csv.meta.json and prints it.
//   snapshot --rect x,y,w,h [--display ID] --out shot.png
//   input    persistent JSON-lines actor: pointer input + AX inspect/tree (see "input actor" below)
//   lock     [--seconds N] [--allow synthetic|tagged] [--countdown 3]
//            Warns first with a 3·2·1 countdown (0.5s per number; --countdown 0 skips it), then
//            drops ALL physical input — pointer, trackpad gestures, force touch, keys, modifiers, media
//            keys — and pins the cursor, until timeout or SIGTERM. Emergency release: Esc six times
//            in a row, ≤1s apart (those presses are swallowed too; the overlay shows the count). Synthetic events pass: those tagged with
//            eventSourceUserData == 0x45594521 ("EYE!"), and with --allow synthetic (default) any
//            event posted by a process (sourceUnixProcessID != 0).
//
// Coordinates: display-local POINTS, top-left origin.
import AppKit
import CoreMedia
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

// MARK: - args / output

var argv = Array(CommandLine.arguments.dropFirst())
let sub = argv.isEmpty ? "" : argv.removeFirst()
func opt(_ name: String) -> String? {
    guard let i = argv.firstIndex(of: "--" + name), i + 1 < argv.count else { return nil }
    return argv[i + 1]
}
func fail(_ msg: String) -> Never {
    FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
    print(json(["error": msg]))
    exit(1)
}
func json(_ o: Any) -> String {
    String(data: try! JSONSerialization.data(withJSONObject: o, options: [.sortedKeys]), encoding: .utf8)!
}
func parseRect(_ s: String?) -> CGRect? {
    guard let p = s?.split(separator: ",").compactMap({ Double($0.trimmingCharacters(in: .whitespaces)) }), p.count == 4 else { return nil }
    return CGRect(x: p[0], y: p[1], width: p[2], height: p[3])
}

var tb = mach_timebase_info_data_t()
mach_timebase_info(&tb)
func machSeconds(_ t: UInt64) -> Double { Double(t) * Double(tb.numer) / Double(tb.denom) / 1e9 }

func displayScale(_ id: CGDirectDisplayID) -> Double {
    guard let m = CGDisplayCopyDisplayMode(id), m.width > 0 else { return 2 }
    return Double(m.pixelWidth) / Double(m.width)
}
func displayRefresh(_ id: CGDirectDisplayID) -> Double {
    let r = CGDisplayCopyDisplayMode(id)?.refreshRate ?? 0
    return r > 0 ? r : 60
}
func screenName(_ id: CGDirectDisplayID) -> String {
    NSScreen.screens.first { ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == id }?
        .localizedName ?? "Display \(id)"
}

/// ScreenCaptureKit calls occasionally never call back (replayd wedges). Every subcommand that awaits SCK
/// arms one of these so the process always exits — with an error the server can act on — instead of hanging.
func deadline(_ seconds: Double, _ what: String) {
    DispatchQueue.global().asyncAfter(deadline: .now() + seconds) {
        FileHandle.standardError.write("eye-capture: \(what) timed out after \(seconds)s (ScreenCaptureKit did not respond)\n".data(using: .utf8)!)
        exit(3)
    }
}

func shareable() async -> SCShareableContent {
    // TCC occasionally reports a spurious "declined" when capture sessions start back-to-back; retry.
    var last: Error?
    for attempt in 0..<5 {
        do { return try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true) }
        catch { last = error; try? await Task.sleep(nanoseconds: UInt64(250_000_000 * (attempt + 1))) }
    }
    fail("ScreenCaptureKit unavailable (Screen Recording permission?): \(last?.localizedDescription ?? "unknown")")
}
func pickDisplay(_ content: SCShareableContent) -> SCDisplay {
    let want = opt("display").flatMap(UInt32.init) ?? CGMainDisplayID()
    guard let d = content.displays.first(where: { $0.displayID == want }) else { fail("display \(want) not found") }
    return d
}

func writePNG(_ img: CGImage, _ path: String) -> Bool {
    let url = URL(fileURLWithPath: path) as CFURL
    guard let dst = CGImageDestinationCreateWithURL(url, UTType.png.identifier as CFString, 1, nil) else { return false }
    CGImageDestinationAddImage(dst, img, nil)
    return CGImageDestinationFinalize(dst)
}

func onTerminate(_ handler: @escaping () -> Void) {
    for sig in [SIGINT, SIGTERM] {
        signal(sig, SIG_IGN)
        let s = DispatchSource.makeSignalSource(signal: sig, queue: .main)
        s.setEventHandler(handler: handler)
        s.resume()
        terminateSources.append(s)
    }
}
var terminateSources: [DispatchSourceSignal] = []

// MARK: - displays

func cmdDisplays() async {
    deadline(5, "displays")
    let content = await shareable()
    let list: [[String: Any]] = content.displays.map { d in
        let b = CGDisplayBounds(d.displayID)
        return ["id": d.displayID, "name": screenName(d.displayID), "main": d.displayID == CGMainDisplayID(),
                "points": ["x": b.origin.x, "y": b.origin.y, "w": b.width, "h": b.height],
                "scale": displayScale(d.displayID), "refresh_hz": displayRefresh(d.displayID)]
    }
    print(json(["displays": list]))
    exit(0)
}

// MARK: - snapshot

func cmdSnapshot() async {
    guard let rect = parseRect(opt("rect")), let out = opt("out") else { fail("snapshot needs --rect x,y,w,h --out file.png") }
    deadline(opt("timeout").flatMap(Double.init) ?? 4, "snapshot")
    let content = await shareable()
    let d = pickDisplay(content)
    let scale = displayScale(d.displayID)
    let cfg = SCStreamConfiguration()
    cfg.sourceRect = rect
    cfg.width = Int(rect.width * scale); cfg.height = Int(rect.height * scale)
    cfg.showsCursor = false
    do {
        let img = try await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(display: d, excludingWindows: []), configuration: cfg)
        guard writePNG(img, out) else { fail("could not write \(out)") }
        print(json(["path": out, "pixels": ["w": img.width, "h": img.height], "scale": scale]))
        exit(0)
    } catch { fail("snapshot failed: \(error.localizedDescription)") }
}

// MARK: - capture

final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate {
    let out: FileHandle
    let outPath: String
    let rect: CGRect
    let scale: Double
    let step: Int
    let keyDir: String?
    let keyEvery: Double
    var buf = ""
    var t0: Double?
    var lastComplete: Double?
    var lastKey = -Double.infinity
    var prev: [UInt8]?
    var base: [UInt8]?
    var complete = 0, idle = 0, other = 0, keyframes = 0
    var identical = 0 // compositor re-deliveries with unchanged pixels (counted in idle)
    var firstT = 0.0, lastT = 0.0
    var streamError: String?
    let q = DispatchQueue(label: "eye.capture")
    // Live state (for <out>.live.json): recent callbacks and the current visible extent.
    var recent: [(t: Double, complete: Bool, interval: Double, frac: Double)] = []
    var curBox: (x0: Double, y0: Double, x1: Double, y1: Double)? = nil
    var curLuma = 0.0
    var movingSince: Double? = nil
    var lastMoving: Double? = nil

    init(outPath: String, rect: CGRect, scale: Double, step: Int, keyDir: String?, keyEvery: Double) {
        FileManager.default.createFile(atPath: outPath, contents: nil)
        guard let h = FileHandle(forWritingAtPath: outPath) else { fail("cannot write \(outPath)") }
        out = h; self.outPath = outPath; self.rect = rect; self.scale = scale; self.step = step
        self.keyDir = keyDir; self.keyEvery = keyEvery
        super.init()
        buf = "t,status,interval_ms,diff,changed_frac,mean_luma,bbox_x0,bbox_y0,bbox_x1,bbox_y1,bbox_w,bbox_h,anch_w,anch_h,anch_cx\n"
    }
    var t0Wall = 0.0         // unix seconds of the first frame
    var anchorX = 0.0        // display points (default: display centre)
    var anchorRowPt = 4.0    // points below the region top
    var anchored: (x0: Double, x1: Double, depth: Double)? = nil

    func flush() {
        guard !buf.isEmpty else { return }
        out.write(buf.data(using: .utf8)!)
        buf = ""
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) { streamError = error.localizedDescription }

    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen,
              let atts = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let info = atts.first,
              let raw = info[.status] as? Int, let status = SCFrameStatus(rawValue: raw) else { return }
        let t = (info[.displayTime] as? UInt64).map(machSeconds) ?? CMSampleBufferGetPresentationTimeStamp(sb).seconds
        if t0 == nil {
            t0 = t; firstT = t
            // Anchor the frame clock (mach seconds) to wall time so Instruments traces can be aligned.
            t0Wall = Date().timeIntervalSince1970 - (machSeconds(mach_absolute_time()) - t)
        }
        lastT = t
        let rel = t - t0!
        switch status {
        case .idle:
            idle += 1
            buf += String(format: "%.5f,i,,,,,,,,,,,,,\n", rel)
            recent.append((rel, false, 0, 0))
            return
        case .complete: break
        default:
            other += 1
            return
        }
        guard let pb = sb.imageBuffer else { return }
        complete += 1
        CVPixelBufferLockBaseAddress(pb, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }
        let w = CVPixelBufferGetWidth(pb), h = CVPixelBufferGetHeight(pb), bpr = CVPixelBufferGetBytesPerRow(pb)
        let p = CVPixelBufferGetBaseAddress(pb)!.assumingMemoryBound(to: UInt8.self)
        let gw = w / step, gh = h / step
        var luma = [UInt8](repeating: 0, count: gw * gh)
        var lumaSum = 0
        for y in 0..<gh {
            let row = p + (y * step) * bpr
            for x in 0..<gw {
                let px = row + (x * step) * 4 // BGRA
                let l = (Int(px[2]) * 54 + Int(px[1]) * 183 + Int(px[0]) * 19) >> 8
                luma[y * gw + x] = UInt8(l)
                lumaSum += l
            }
        }
        if base == nil || base!.count != luma.count { base = luma }
        var diffSum = 0, changed = 0
        var x0 = Int.max, y0 = Int.max, x1 = -1, y1 = -1
        let hasPrev = prev?.count == luma.count
        luma.withUnsafeBufferPointer { L in
            base!.withUnsafeBufferPointer { B in
                for i in 0..<L.count {
                    if hasPrev {
                        let d = abs(Int(L[i]) - Int(prev![i]))
                        diffSum += d
                        if d > 8 { changed += 1 }
                    }
                    if abs(Int(L[i]) - Int(B[i])) > 24 {
                        let x = i % gw, y = i / gw
                        if x < x0 { x0 = x }; if x > x1 { x1 = x }
                        if y < y0 { y0 = y }; if y > y1 { y1 = y }
                    }
                }
            }
        }
        // A "complete" frame whose pixels equal the previous one is not a new image for the viewer: the compositor
        // re-delivers the region when anything else on screen animates (e.g. the lock overlay, even though it is
        // excluded from capture). Count it as idle, or a stalled animation would read as full frame rate.
        if hasPrev && diffSum == 0 {
            complete -= 1; idle += 1; identical += 1
            buf += String(format: "%.5f,i,,,,,,,,,,,,,\n", rel)
            recent.append((rel, false, 0, 0))
            return
        }
        let n = Double(max(1, luma.count))
        let interval = lastComplete.map { (t - $0) * 1000 } ?? 0
        let k = Double(step) / scale // grid cell → points
        // Top-anchored extent: along a row `anchorRowPt` below the region top, the contiguous run of
        // changed cells around `anchorX` (gaps ≤ tolerance bridged), then how far down the change
        // reaches from the top at 25%/75% of that run. For a panel hanging from the top edge (the
        // notch) this is its width/height, immune to changes elsewhere in the region.
        var ax0 = -1.0, ax1 = -1.0, adepth = 0.0
        let tol = max(2, Int(6.0 / k))
        let changedAt = { (x: Int, y: Int) -> Bool in abs(Int(luma[y * gw + x]) - Int(self.base![y * gw + x])) > 24 }
        let ar = min(gh - 1, max(0, Int(anchorRowPt / k)))
        let ac = min(gw - 1, max(0, Int((anchorX - rect.origin.x) / k)))
        if gw > 0, gh > 0 {
            var lo = ac, hi = ac, gapL = 0, gapR = 0
            var any = changedAt(ac, ar)
            var x = ac - 1
            while x >= 0 { if changedAt(x, ar) { lo = x; gapL = 0; any = true } else { gapL += 1; if gapL > tol { break } }; x -= 1 }
            x = ac + 1
            while x < gw { if changedAt(x, ar) { hi = x; gapR = 0; any = true } else { gapR += 1; if gapR > tol { break } }; x += 1 }
            if any && hi > lo {
                ax0 = rect.origin.x + Double(lo) * k; ax1 = rect.origin.x + Double(hi + 1) * k
                var deepest = 0
                for col in [lo + (hi - lo) / 4, lo + 3 * (hi - lo) / 4] {
                    var y = 0, last = -1, gap = 0
                    while y < gh { if changedAt(col, y) { last = y; gap = 0 } else { gap += 1; if gap > tol * 2 { break } }; y += 1 }
                    deepest = max(deepest, last + 1)
                }
                adepth = Double(deepest) * k
            }
        }
        anchored = ax0 >= 0 ? (ax0, ax1, adepth) : nil
        let has = x1 >= 0
        let bx0 = has ? Double(x0) * k : 0, by0 = has ? Double(y0) * k : 0
        let bx1 = has ? Double(x1 + 1) * k : 0, by1 = has ? Double(y1 + 1) * k : 0
        buf += String(format: "%.5f,c,%.3f,%.3f,%.5f,%.2f,%.1f,%.1f,%.1f,%.1f,%.1f,%.1f,%.1f,%.1f,%.1f\n",
                      rel, interval, hasPrev ? Double(diffSum) / n : 0, hasPrev ? Double(changed) / n : 0,
                      Double(lumaSum) / n, bx0, by0, bx1, by1, bx1 - bx0, by1 - by0,
                      ax0 >= 0 ? ax1 - ax0 : 0, adepth, ax0 >= 0 ? (ax0 + ax1) / 2 : 0)
        lastComplete = t
        prev = luma
        if buf.utf8.count > 64_000 { flush() }
        let fracNow = hasPrev ? Double(changed) / n : 0
        recent.append((rel, true, interval, fracNow))
        curBox = has ? (bx0, by0, bx1, by1) : nil
        curLuma = Double(lumaSum) / n
        if fracNow > 0.0005 { if movingSince == nil { movingSince = rel }; lastMoving = rel }
        else if let lm = lastMoving, rel - lm > 0.15 { movingSince = nil }

        if let keyDir, rel * 1000 - lastKey >= keyEvery {
            lastKey = rel * 1000
            if let img = cgImage(pb) {
                let name = String(format: "%@/frame_%08.1fms.png", keyDir, rel * 1000)
                if writePNG(img, name) { keyframes += 1 }
            }
        }
    }

    /// Snapshot of what is visible right now; written to <out>.live.json ~10×/s. Runs on `q`.
    func liveJSON(refresh: Double) -> String {
        let now = recent.last?.t ?? 0
        recent.removeAll { now - $0.t > 1.0 }
        let c = recent.filter { $0.complete }
        let gaps = c.map { $0.interval }.filter { $0 > 0 }
        let period = 1000 / refresh
        var o: [String: Any] = [
            "t": now, "frames_total": complete, "idle_total": idle,
            "last_1s": ["new_frames": c.count, "idle": recent.count - c.count,
                        "max_gap_ms": gaps.max() ?? 0, "hitches": gaps.filter { $0 >= 1.5 * period }.count,
                        "max_moved_frac": c.map { $0.frac }.max() ?? 0],
            "moving": movingSince != nil && (lastMoving.map { now - $0 <= 0.15 } ?? false),
            "mean_luma": curLuma,
            "rect_points": ["x": rect.origin.x, "y": rect.origin.y, "w": rect.width, "h": rect.height],
            "refresh_hz": refresh,
        ]
        if let a = anchored {
            o["anchored_screen"] = ["x0": a.x0, "x1": a.x1, "w": a.x1 - a.x0, "y0": rect.origin.y,
                                    "y1": rect.origin.y + a.depth, "h": a.depth, "cx": (a.x0 + a.x1) / 2]
        } else {
            o["anchored_screen"] = NSNull()
        }
        o["anchor"] = ["x": anchorX, "row_pt": anchorRowPt]
        o["ax"] = axEnabled
        if axEnabled {
            hoverLock.lock(); let hv = liveHover, hp = liveHoverAt, ht = liveHoverT; hoverLock.unlock()
            o["hover"] = hv ?? NSNull()
            o["hover_point"] = [hp.x, hp.y]
            o["hover_age_s"] = ht > 0 ? machSeconds(mach_absolute_time()) - ht : NSNull()
        }
        if let b = curBox {
            // Extent of everything differing from the first frame, region-relative AND in display points.
            o["changed_extent"] = ["x0": b.x0, "y0": b.y0, "x1": b.x1, "y1": b.y1, "w": b.x1 - b.x0, "h": b.y1 - b.y0]
            o["changed_extent_screen"] = ["x0": rect.origin.x + b.x0, "y0": rect.origin.y + b.y0,
                                          "x1": rect.origin.x + b.x1, "y1": rect.origin.y + b.y1]
        } else {
            o["changed_extent"] = NSNull()
            o["changed_extent_screen"] = NSNull()
        }
        return json(o)
    }

    func cgImage(_ pb: CVPixelBuffer) -> CGImage? {
        let w = CVPixelBufferGetWidth(pb), h = CVPixelBufferGetHeight(pb), bpr = CVPixelBufferGetBytesPerRow(pb)
        guard let base = CVPixelBufferGetBaseAddress(pb),
              let ctx = CGContext(data: base, width: w, height: h, bitsPerComponent: 8, bytesPerRow: bpr,
                                  space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
        else { return nil }
        return ctx.makeImage()
    }
}

// MARK: - accessibility (AX) inspection
//
// Every AX call is answered on the TARGET app's main thread, and a SwiftUI app that sees any AX client starts
// maintaining its accessibility graph every frame (measured: ~18% more main-thread time, −25% fps). Callers
// decide when that's acceptable. All frames are GLOBAL points, top-left origin (CG / AX space) — the same
// space as the pointer and eye_act x/y; on the main display that equals display-local points.

/// Topmost on-screen window under a global top-left point (CGWindowList is front to back), skipping our own
/// click-through lock overlay.
func topWindow(at p: CGPoint) -> [String: Any]? {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
    for w in list {
        guard let b = w[kCGWindowBounds as String] as? [String: CGFloat],
              ((w[kCGWindowAlpha as String] as? Double) ?? 1) > 0,
              (w[kCGWindowOwnerName as String] as? String) != "eye-capture" else { continue }
        let r = CGRect(x: b["X"] ?? 0, y: b["Y"] ?? 0, width: b["Width"] ?? 0, height: b["Height"] ?? 0)
        guard r.contains(p) else { continue }
        return ["pid": w[kCGWindowOwnerPID as String] ?? 0, "owner": w[kCGWindowOwnerName as String] ?? "",
                "name": w[kCGWindowName as String] ?? "", "layer": w[kCGWindowLayer as String] ?? 0,
                "number": w[kCGWindowNumber as String] ?? 0, "bounds": [r.minX, r.minY, r.width, r.height]]
    }
    return nil
}

enum AXI {
    static let system: AXUIElement = {
        let s = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(s, 0.25)
        return s
    }()
    /// The per-node attributes fetched in ONE round trip (AXUIElementCopyMultipleAttributeValues).
    static let nodeAttrs: [String] = [kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute,
                                      kAXValueAttribute, kAXIdentifierAttribute, kAXHelpAttribute, kAXPositionAttribute,
                                      kAXSizeAttribute, kAXEnabledAttribute, kAXFocusedAttribute, kAXSelectedAttribute]
    static let boringRoles: Set<String> = ["AXGroup", "AXUnknown", "AXSplitGroup", "AXScrollArea", "AXLayoutArea",
                                           "AXLayoutItem", "AXOpaqueProviderGroup"]

    static func r1(_ v: Double) -> Double { (v * 10).rounded() / 10 }
    static func raw(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
        var v: CFTypeRef?
        return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
    }
    static func many(_ el: AXUIElement, _ names: [String]) -> [String: CFTypeRef] {
        var vals: CFArray?
        guard AXUIElementCopyMultipleAttributeValues(el, names as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &vals) == .success,
              let arr = vals as? [AnyObject] else { return [:] }
        var out: [String: CFTypeRef] = [:]
        for (n, v) in zip(names, arr) {
            if CFGetTypeID(v) == AXValueGetTypeID(), AXValueGetType(v as! AXValue) == .axError { continue }
            out[n] = v
        }
        return out
    }
    static func isElement(_ v: CFTypeRef) -> Bool { CFGetTypeID(v) == AXUIElementGetTypeID() }
    static func bool(_ v: CFTypeRef?) -> Bool? {
        guard let v else { return nil }
        if CFGetTypeID(v) == CFBooleanGetTypeID() { return CFBooleanGetValue((v as! CFBoolean)) }
        return (v as? NSNumber)?.boolValue
    }
    static func text(_ v: CFTypeRef?, max: Int = 200) -> String? {
        guard let v else { return nil }
        var s: String?
        if CFGetTypeID(v) == CFBooleanGetTypeID() { s = CFBooleanGetValue((v as! CFBoolean)) ? "true" : "false" }
        else if let x = v as? String { s = x }
        else if let x = v as? NSAttributedString { s = x.string }
        else if let x = v as? URL { s = x.absoluteString }
        else if let x = v as? NSNumber { s = x.stringValue }
        guard let s else { return nil }
        let clean = s.replacingOccurrences(of: "\n", with: "⏎")
        return clean.count > max ? String(clean.prefix(max)) + "…" : clean
    }
    static func geometry(_ v: CFTypeRef) -> [Double]? {
        guard CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
        let a = v as! AXValue
        switch AXValueGetType(a) {
        case .cgPoint: var p = CGPoint.zero; AXValueGetValue(a, .cgPoint, &p); return [r1(p.x), r1(p.y)]
        case .cgSize: var s = CGSize.zero; AXValueGetValue(a, .cgSize, &s); return [r1(s.width), r1(s.height)]
        case .cgRect: var r = CGRect.zero; AXValueGetValue(a, .cgRect, &r); return [r1(r.minX), r1(r.minY), r1(r.width), r1(r.height)]
        case .cfRange: var r = CFRange(); AXValueGetValue(a, .cfRange, &r); return [Double(r.location), Double(r.length)]
        default: return nil
        }
    }
    static func frame(_ vals: [String: CFTypeRef]) -> CGRect? {
        guard let p = vals[kAXPositionAttribute].flatMap(geometry), let s = vals[kAXSizeAttribute].flatMap(geometry),
              p.count == 2, s.count == 2 else { return nil }
        return CGRect(x: p[0], y: p[1], width: s[0], height: s[1])
    }
    static func pid(_ el: AXUIElement) -> pid_t { var p: pid_t = 0; AXUIElementGetPid(el, &p); return p }

    /// Compact node: role/subrole/labels/value/frame/state.
    static func node(_ vals: [String: CFTypeRef], maxText: Int) -> [String: Any] {
        var o: [String: Any] = [:]
        for (k, name) in [("role", kAXRoleAttribute), ("subrole", kAXSubroleAttribute), ("title", kAXTitleAttribute),
                          ("description", kAXDescriptionAttribute), ("identifier", kAXIdentifierAttribute), ("help", kAXHelpAttribute)] {
            if let s = text(vals[name], max: maxText), !s.isEmpty { o[k] = s }
        }
        if let v = vals[kAXValueAttribute] {
            if let s = text(v, max: maxText) { if !s.isEmpty { o["value"] = s } } else if let g = geometry(v) { o["value"] = g }
        }
        if let f = frame(vals) { o["frame"] = [r1(f.minX), r1(f.minY), r1(f.width), r1(f.height)] }
        for (k, name) in [("enabled", kAXEnabledAttribute), ("focused", kAXFocusedAttribute), ("selected", kAXSelectedAttribute)] {
            if let b = bool(vals[name]) { o[k] = b }
        }
        return o
    }
    static func label(_ n: [String: Any]) -> String? {
        for k in ["title", "description", "value", "identifier", "help"] { if let s = n[k] as? String, !s.isEmpty { return s } }
        return nil
    }
    /// `Button "Camera"` — role without the AX prefix, plus subrole and the best label.
    static func short(_ n: [String: Any]) -> String {
        var s = String((n["role"] as? String ?? "?").replacingOccurrences(of: "AX", with: "", options: .anchored))
        if let sub = n["subrole"] as? String { s += "/" + sub.replacingOccurrences(of: "AX", with: "", options: .anchored) }
        if let l = label(n) { s += " \"\(l.count > 40 ? String(l.prefix(40)) + "…" : l)\"" }
        return s
    }
    static func summary(_ el: AXUIElement) -> String { short(node(many(el, nodeAttrs), maxText: 60)) }

    /// The element under a global point. Hit-tests system-wide; if that lands on one of our own processes (the
    /// lock overlay), asks the app that owns the topmost real window there instead.
    static func hit(_ p: CGPoint) -> AXUIElement? {
        var el: AXUIElement?
        if AXUIElementCopyElementAtPosition(system, Float(p.x), Float(p.y), &el) == .success, let el,
           NSRunningApplication(processIdentifier: pid(el))?.localizedName != "eye-capture" { return el }
        guard let w = topWindow(at: p), let owner = (w["pid"] as? NSNumber)?.int32Value else { return nil }
        let app = AXUIElementCreateApplication(owner)
        AXUIElementSetMessagingTimeout(app, 0.25)
        var e2: AXUIElement?
        return AXUIElementCopyElementAtPosition(app, Float(p.x), Float(p.y), &e2) == .success ? e2 : nil
    }

    /// EVERYTHING the element exposes: every attribute (elements summarized, arrays capped), actions,
    /// parameterized attribute names, app, ancestors (nearest first) and a readable path.
    static func inspect(_ el: AXUIElement, maxText: Int = 400) -> [String: Any] {
        var names: CFArray?
        var all: [String] = []
        if AXUIElementCopyAttributeNames(el, &names) == .success, let n = names as? [String] { all = n }
        let vals = many(el, Array(Set(all + nodeAttrs)))
        var o = node(vals, maxText: maxText)
        var extra: [String: Any] = [:]
        let skip = Set(nodeAttrs + [kAXParentAttribute, kAXTopLevelUIElementAttribute])
        for n in all.sorted() where !skip.contains(n) {
            guard let v = vals[n] else { continue }
            let key = n.hasPrefix("AX") ? String(n.dropFirst(2)) : n
            if isElement(v) { extra[key] = summary(v as! AXUIElement) }
            else if let arr = v as? [AnyObject] {
                if let f = arr.first, isElement(f) {
                    extra[key] = arr.count <= 6 ? arr.map { summary($0 as! AXUIElement) } : ["\(arr.count) elements"]
                } else { extra[key] = arr.prefix(20).map { text($0, max: 80) ?? geometry($0).map { "\($0)" } ?? "?" } }
            } else if let s = text(v, max: maxText) { extra[key] = s }
            else if let g = geometry(v) { extra[key] = g }
            else { extra[key] = "<\(CFCopyTypeIDDescription(CFGetTypeID(v)) as String? ?? "?")>" }
        }
        if !extra.isEmpty { o["attributes"] = extra }
        var acts: CFArray?
        if AXUIElementCopyActionNames(el, &acts) == .success, let a = acts as? [String], !a.isEmpty {
            o["actions"] = a.map { $0.replacingOccurrences(of: "AX", with: "", options: .anchored) }
        }
        var pn: CFArray?
        if AXUIElementCopyParameterizedAttributeNames(el, &pn) == .success, let p = pn as? [String], !p.isEmpty { o["parameterized_attributes"] = p }
        let p = pid(el)
        o["pid"] = p
        if let app = NSRunningApplication(processIdentifier: p) { o["app"] = app.localizedName ?? ""; o["bundle_id"] = app.bundleIdentifier ?? "" }
        var chain: [[String: Any]] = []
        var cur = raw(el, kAXParentAttribute)
        while let c = cur, isElement(c), chain.count < 20 {
            let pe = c as! AXUIElement
            let n = node(many(pe, nodeAttrs), maxText: 60)
            chain.append(n)
            if n["role"] as? String == "AXApplication" { break }
            cur = raw(pe, kAXParentAttribute)
        }
        o["ancestors"] = chain
        if let w = chain.first(where: { $0["role"] as? String == "AXWindow" }) {
            o["window"] = ["title": w["title"] ?? "", "frame": w["frame"] ?? NSNull(), "subrole": w["subrole"] ?? ""]
        }
        o["path"] = (chain.reversed().filter { $0["role"] as? String != "AXApplication" } + [o]).map(short).joined(separator: " › ")
        return o
    }

    /// One indented line per node: `Button "Camera" #id = value [x,y w×h] (disabled) {Press}`.
    static func line(_ n: [String: Any], _ indent: Int) -> String {
        var s = String(repeating: "  ", count: indent) + short(n)
        if let id = n["identifier"] as? String, label(n) != id { s += " #\(id)" }
        if let v = n["value"] as? String, label(n) != v { s += " = \(v.count > 50 ? String(v.prefix(50)) + "…" : v)" }
        if let f = n["frame"] as? [Double] { s += String(format: " [%.0f,%.0f %.0f×%.0f]", f[0], f[1], f[2], f[3]) }
        var flags: [String] = []
        if n["enabled"] as? Bool == false { flags.append("disabled") }
        if n["focused"] as? Bool == true { flags.append("focused") }
        if n["selected"] as? Bool == true { flags.append("selected") }
        if !flags.isEmpty { s += " (\(flags.joined(separator: ",")))" }
        if let a = n["actions"] as? [String], !a.isEmpty { s += " {\(a.joined(separator: ","))}" }
        return s
    }

    struct TreeState { var lines: [String] = []; var nodes = 0; var visited = 0; var truncated = false }
    /// Walks the element tree. basic: hides unlabeled layout containers (their children move up) and caps text;
    /// full: every node plus its actions. Subtrees whose frame misses `clip` are skipped.
    static func walk(_ el: AXUIElement, depth: Int, indent: Int, full: Bool, clip: CGRect?, maxDepth: Int, maxNodes: Int,
                     st: inout TreeState) -> [String: Any]? {
        if st.nodes >= maxNodes || st.visited >= maxNodes * 4 { st.truncated = true; return nil }
        st.visited += 1
        let vals = many(el, nodeAttrs + [kAXChildrenAttribute])
        if let clip, let f = frame(vals), f.width > 0, f.height > 0, !f.intersects(clip) { return nil }
        var n = node(vals, maxText: full ? 200 : 60)
        let role = n["role"] as? String ?? "?"
        let boring = !full && depth > 0 && boringRoles.contains(role) && label(n) == nil
        if full {
            var acts: CFArray?
            if AXUIElementCopyActionNames(el, &acts) == .success, let a = acts as? [String], !a.isEmpty {
                n["actions"] = a.map { $0.replacingOccurrences(of: "AX", with: "", options: .anchored) }
            }
        }
        var childIndent = indent
        if !boring { st.lines.append(line(n, indent)); st.nodes += 1; childIndent += 1 }
        let kids = (vals[kAXChildrenAttribute] as? [AnyObject] ?? []).filter(isElement)
        var children: [[String: Any]] = []
        if depth < maxDepth {
            for k in kids {
                if let c = walk(k as! AXUIElement, depth: depth + 1, indent: childIndent, full: full, clip: clip,
                                maxDepth: maxDepth, maxNodes: maxNodes, st: &st) { children.append(c) }
            }
        } else if !kids.isEmpty {
            st.lines.append(String(repeating: "  ", count: childIndent) + "… \(kids.count) children below depth \(maxDepth)")
        }
        if !children.isEmpty { n["children"] = children }
        return n
    }

    static let skipOwners: Set<String> = ["Window Server", "eye-capture", "Dock", "WindowManager", "Wallpaper",
                                          "Control Center", "SystemUIServer", "Spotlight", "TextInputMenuAgent",
                                          "Notification Center", "Screenshot", "MenuBarAgent"]
    /// The window (or top-level element) an element lives in.
    static func windowRoot(of el: AXUIElement) -> AXUIElement {
        var cur = el
        while true {
            if text(raw(cur, kAXRoleAttribute)) == "AXWindow" { return cur }
            guard let p = raw(cur, kAXParentAttribute), isElement(p) else { return cur }
            let pe = p as! AXUIElement
            if text(raw(pe, kAXRoleAttribute)) == "AXApplication" { return cur }
            cur = pe
        }
    }
    typealias Observed = (pid: pid_t, owner: String, root: AXUIElement, bounds: CGRect)
    /// Root AX elements (windows) visible in `rect` (global points), front to back. Without `process`: AX
    /// hit-tests a grid of points, so only what is really on top counts (transparent full-screen windows and
    /// occluded windows are ignored), skipping menu bars and system UI. With `process` (app name substring or
    /// pid): that app's windows intersecting the rect, visible or not.
    static func observedWindows(_ rect: CGRect, process: String?, limit: Int) -> [Observed] {
        var out: [Observed] = []
        func add(_ root: AXUIElement, _ pid: pid_t) {
            guard out.count < limit, !out.contains(where: { CFEqual($0.root, root) }) else { return }
            let f = frame(many(root, [kAXPositionAttribute, kAXSizeAttribute])) ?? rect
            out.append((pid, NSRunningApplication(processIdentifier: pid)?.localizedName ?? "pid \(pid)", root, f))
        }
        if let want = process?.lowercased() {
            // Not NSWorkspace.runningApplications: this actor is long-lived and never spins the run loop that
            // refreshes it, so apps launched after it started (every relaunch of the app under test) were missing.
            // The window server's list is always live.
            var pids: [pid_t] = []
            if let n = pid_t(want) { pids.append(n) }
            let infos = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] ?? []
            for w in infos {
                guard let p = (w[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value, !pids.contains(p) else { continue }
                let names = [w[kCGWindowOwnerName as String] as? String, NSRunningApplication(processIdentifier: p)?.localizedName]
                if names.contains(where: { $0?.lowercased().contains(want) ?? false }) { pids.append(p) }
            }
            for pid in pids {
                let app = AXUIElementCreateApplication(pid)
                AXUIElementSetMessagingTimeout(app, 0.5)
                let wins = (raw(app, kAXWindowsAttribute) as? [AXUIElement] ?? [])
                    .filter { frame(many($0, [kAXPositionAttribute, kAXSizeAttribute]))?.intersects(rect) ?? false }
                for w in wins { add(w, pid) }
                if wins.isEmpty {
                    // Borderless panels are often missing from AXWindows: hit-test the rect inside the app.
                    var el: AXUIElement?
                    if AXUIElementCopyElementAtPosition(app, Float(rect.midX), Float(rect.midY), &el) == .success, let el {
                        add(windowRoot(of: el), pid)
                    }
                }
            }
            return out
        }
        let cols = min(10, max(3, Int(rect.width / 40))), rows = min(8, max(2, Int(rect.height / 40)))
        for r in 0..<rows {
            for c in 0..<cols {
                let p = CGPoint(x: rect.minX + rect.width * (Double(c) + 0.5) / Double(cols),
                                y: rect.minY + rect.height * (Double(r) + 0.5) / Double(rows))
                guard let el = hit(p) else { continue }
                let pid = pid(el)
                guard let name = NSRunningApplication(processIdentifier: pid)?.localizedName, !skipOwners.contains(name) else { continue }
                let root = windowRoot(of: el)
                if text(raw(root, kAXRoleAttribute)) == "AXMenuBar" { continue }
                add(root, pid)
            }
        }
        return out
    }

    static func tree(rect: CGRect, process: String?, full: Bool, clip: Bool, maxDepth: Int, maxNodes: Int, limit: Int) -> [String: Any] {
        var text: [String] = []
        var windows: [[String: Any]] = []
        var total = 0
        for w in observedWindows(rect, process: process, limit: limit) {
            var st = TreeState()
            let t = walk(w.root, depth: 0, indent: 1, full: full, clip: clip ? rect : nil, maxDepth: maxDepth,
                         maxNodes: max(10, maxNodes - total), st: &st)
            total += st.nodes
            text.append(String(format: "%@ (pid %d) [%.0f,%.0f %.0f×%.0f]%@", w.owner, w.pid, w.bounds.minX, w.bounds.minY,
                               w.bounds.width, w.bounds.height, st.truncated ? " — TRUNCATED (raise max_nodes or narrow rect)" : ""))
            text.append(contentsOf: st.lines)
            windows.append(["pid": w.pid, "app": w.owner, "cg_bounds": [w.bounds.minX, w.bounds.minY, w.bounds.width, w.bounds.height],
                            "nodes": st.nodes, "truncated": st.truncated, "tree": t ?? NSNull()])
            if total >= maxNodes { break }
        }
        if windows.isEmpty { text.append("(no app windows with an accessibility tree intersect [\(Int(rect.minX)),\(Int(rect.minY)) \(Int(rect.width))×\(Int(rect.height))])") }
        return ["text": text.joined(separator: "\n"), "windows": windows, "nodes": total]
    }
}

/// Live hover state shared with the capture's live JSON (written by CursorSampler, read on the recorder queue).
let hoverLock = NSLock()
var liveHover: [String: Any]? = nil
var liveHoverAt: CGPoint = .zero
var liveHoverT = 0.0

/// Logs the pointer position at `hz` and, at most `axHz` times a second, the accessibility element under it.
/// When the element changes, its FULL description (AXI.inspect) goes to the live JSON (`hover`) and to
/// hover.jsonl; while it stays the same its frame/state is refreshed every 0.5s. AX hit-tests are answered on
/// the TARGET app's main thread (see AXI), so axHz 0 turns all of it off for clean performance numbers.
final class CursorSampler {
    let path: String, hz: Double, axHz: Double, hoverPath: String
    var running = true
    let done = DispatchSemaphore(value: 0)
    init(path: String, hz: Double, axHz: Double) {
        self.path = path; self.hz = hz; self.axHz = axHz
        hoverPath = (path as NSString).deletingLastPathComponent + "/hover.jsonl"
    }

    func start() {
        Thread { [self] in
            FileManager.default.createFile(atPath: path, contents: nil)
            guard let h = FileHandle(forWritingAtPath: path) else { done.signal(); return }
            h.write("t_mach,x,y,buttons,ax_pid,ax_role,ax_label\n".data(using: .utf8)!)
            var hh: FileHandle?
            if axHz > 0 { FileManager.default.createFile(atPath: hoverPath, contents: nil); hh = FileHandle(forWritingAtPath: hoverPath) }
            var lastAX = -Double.infinity, lastRefresh = -Double.infinity
            var cur: AXUIElement?
            var info: [String: Any]? = nil
            var axPid: Int32 = 0, axRole = "", axLabel = ""
            var buf = ""
            let period = 1.0 / max(1, hz)
            func publish(_ now: Double, _ p: CGPoint, _ kind: String) {
                hoverLock.lock(); liveHover = info; liveHoverAt = p; liveHoverT = now; hoverLock.unlock()
                hh?.write((json(["t": now, "x": p.x, "y": p.y, "kind": kind, "hover": (info as Any?) ?? NSNull()]) + "\n").data(using: .utf8)!)
                axPid = (info?["pid"] as? Int32) ?? 0
                axRole = info?["role"] as? String ?? ""
                axLabel = info.flatMap { AXI.label($0) } ?? ""
                if axLabel.isEmpty, let anc = info?["ancestors"] as? [[String: Any]] {
                    // SwiftUI leaves are often unlabeled: the nearest labeled ancestor, prefixed by how far up ("^2 Timer").
                    for (i, a) in anc.prefix(3).enumerated() { if let l = AXI.label(a) { axLabel = "^\(i + 1) \(l)"; break } }
                }
            }
            while running {
                let now = machSeconds(mach_absolute_time())
                let p = CGEvent(source: nil)?.location ?? .zero
                let buttons = NSEvent.pressedMouseButtons
                if axHz > 0, now - lastAX >= 1 / axHz {
                    lastAX = now
                    let el = AXI.hit(p)
                    if let el, let c = cur, CFEqual(el, c) {
                        if now - lastRefresh >= 0.5 {
                            lastRefresh = now
                            let n = AXI.node(AXI.many(el, AXI.nodeAttrs), maxText: 400)
                            var changed = false
                            for (k, v) in n where !((info?[k] as AnyObject?)?.isEqual(v) ?? false) { info?[k] = v; changed = true }
                            if changed { publish(now, p, "update") }
                        }
                    } else if el != nil || cur != nil {
                        cur = el; lastRefresh = now
                        info = el.map { AXI.inspect($0) }
                        publish(now, p, el == nil ? "none" : "enter")
                    }
                }
                let clean = { (s: String) in String(s.prefix(60)).replacingOccurrences(of: ",", with: " ").replacingOccurrences(of: "\n", with: " ") }
                buf += String(format: "%.5f,%.1f,%.1f,%d,%d,%@,%@\n", now, p.x, p.y, buttons, axPid, clean(axRole), clean(axLabel))
                if buf.utf8.count > 16_000 { h.write(buf.data(using: .utf8)!); buf = "" }
                Thread.sleep(forTimeInterval: period)
            }
            h.write(buf.data(using: .utf8)!)
            try? h.close()
            try? hh?.close()
            done.signal()
        }.start()
    }
    func stop() { running = false; _ = done.wait(timeout: .now() + 1) }
}

func cmdCapture() async {
    guard let rect = parseRect(opt("rect")), let outPath = opt("out") else {
        fail("capture needs --rect x,y,w,h --out run.csv")
    }
    let seconds = opt("seconds").flatMap(Double.init) ?? 30
    let startedFlag = NSLock(); var started = false
    DispatchQueue.global().asyncAfter(deadline: .now() + 8) {
        startedFlag.lock(); let ok = started; startedFlag.unlock()
        if !ok { FileHandle.standardError.write("eye-capture: capture start timed out after 8s (ScreenCaptureKit did not respond)\n".data(using: .utf8)!); exit(3) }
    }
    let content = await shareable()
    let d = pickDisplay(content)
    let scale = displayScale(d.displayID)
    let refresh = displayRefresh(d.displayID)
    let fps = opt("fps").flatMap(Double.init) ?? refresh
    // Keep the per-frame analysis ~≤150k samples so it never becomes the bottleneck.
    let px = rect.width * scale * rect.height * scale
    let step = opt("step").flatMap(Int.init) ?? max(1, Int(ceil(sqrt(px / 150_000))))
    let keyDir = opt("keyframes-dir")
    if let keyDir { try? FileManager.default.createDirectory(atPath: keyDir, withIntermediateDirectories: true) }
    let rec = Recorder(outPath: outPath, rect: rect, scale: scale, step: step, keyDir: keyDir,
                       keyEvery: opt("keyframe-ms").flatMap(Double.init) ?? 100)
    rec.anchorX = opt("anchor-x").flatMap(Double.init) ?? Double(CGDisplayBounds(d.displayID).width) / 2
    rec.anchorRowPt = opt("anchor-row").flatMap(Double.init) ?? 4

    let cfg = SCStreamConfiguration()
    cfg.sourceRect = rect
    cfg.width = Int(rect.width * scale); cfg.height = Int(rect.height * scale)
    cfg.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(max(1, fps.rounded())))
    cfg.queueDepth = 8
    cfg.pixelFormat = kCVPixelFormatType_32BGRA
    cfg.showsCursor = false
    let stream = SCStream(filter: SCContentFilter(display: d, excludingWindows: []), configuration: cfg, delegate: rec)
    do {
        try stream.addStreamOutput(rec, type: .screen, sampleHandlerQueue: rec.q)
        try await stream.startCapture()
    } catch { fail("capture start failed: \(error.localizedDescription)") }
    startedFlag.withLock { started = true }
    let wallStart = Date()
    FileHandle.standardError.write("eye-capture: recording \(rect) on display \(d.displayID) @\(refresh)Hz\n".data(using: .utf8)!)

    // Cursor sampler (separate thread, own clock = mach seconds like the frames).
    let cursor: CursorSampler? = opt("cursor") == "off" ? nil
        : CursorSampler(path: (outPath as NSString).deletingLastPathComponent + "/cursor.csv",
                        hz: opt("cursor-hz").flatMap(Double.init) ?? 60,
                        axHz: opt("ax-hz").flatMap(Double.init) ?? 0)
    axEnabled = cursor != nil && (cursor?.axHz ?? 0) > 0
    cursor?.start()

    var finished = false
    let finish: () -> Void = {
        guard !finished else { return }
        finished = true
        cursor?.stop()
        // ScreenCaptureKit's stopCapture() can hang forever (seen right after another process took an
        // SCK screenshot). The frames are already on disk, so never let it block the exit.
        let wrote = NSLock()
        var written = false
        let writeMetaAndExit: (Bool) -> Void = { stopTimedOut in
            wrote.lock()
            guard !written else { wrote.unlock(); return }
            written = true
            rec.q.sync { rec.flush() }
            try? rec.out.close()
            let meta: [String: Any] = [
                "csv": outPath, "display_id": d.displayID, "display_name": screenName(d.displayID),
                "rect_points": ["x": rect.origin.x, "y": rect.origin.y, "w": rect.width, "h": rect.height],
                "scale": scale, "refresh_hz": refresh, "requested_fps": fps, "sample_step": step,
                "started_at": ISO8601DateFormatter().string(from: wallStart),
                "wall_seconds": Date().timeIntervalSince(wallStart),
                "frames_complete": rec.complete, "frames_idle": rec.idle, "frames_identical": rec.identical, "frames_other": rec.other,
                "span_seconds": rec.lastT - rec.firstT, "keyframes": rec.keyframes, "keyframes_dir": keyDir ?? NSNull(),
                "t0_mach": rec.t0 ?? 0, "t0_wall": rec.t0Wall, "cursor_csv": cursor?.path ?? NSNull(),
                "stream_error": rec.streamError ?? NSNull(),
                "stop_timed_out": stopTimedOut,
            ]
            let mj = json(meta)
            try? mj.write(toFile: outPath + ".meta.json", atomically: true, encoding: .utf8)
            print(mj)
            fflush(stdout)
            exit(0)
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + 2) { writeMetaAndExit(true) }
        Task {
            try? await stream.stopCapture()
            writeMetaAndExit(false)
        }
    }
    onTerminate(finish)
    DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { finish() }
    let flushTimer = DispatchSource.makeTimerSource(queue: rec.q)
    flushTimer.schedule(deadline: .now() + 0.5, repeating: 0.5)
    flushTimer.setEventHandler { rec.flush() }
    flushTimer.resume()
    keep.append(flushTimer)
    let livePath = outPath + ".live.json", liveTmp = livePath + ".tmp"
    let liveTimer = DispatchSource.makeTimerSource(queue: rec.q)
    liveTimer.schedule(deadline: .now() + 0.1, repeating: 0.1)
    liveTimer.setEventHandler {
        try? rec.liveJSON(refresh: refresh).write(toFile: liveTmp, atomically: false, encoding: .utf8)
        rename(liveTmp, livePath)
    }
    liveTimer.resume()
    keep.append(liveTimer)
}
var keep: [Any] = []
var axEnabled = false

// MARK: - lock

let eyeTag: Int64 = 0x45594521
let legacyTag: Int64 = 0x4E4E4452
let pointerTypes: Set<UInt32> = [1, 2, 3, 4, 5, 6, 7, 22, 23, 24, 25, 26, 27, 29, 30, 31, 32]
var lockTap: CFMachPort?
var allowSynthetic = true
/// Emergency release: `panicCount` physical Esc presses in a row, each within `panicGap` seconds of the previous.
/// Each press is still dropped. The overlay pill shows the streak as filling dots.
let panicCount = 6
let panicGap = 1.0
var escStreak = 0
var escLast = 0.0
var blocked = 0, passed = 0
var pidCounts: [Int64: Int] = [:] // source pid → pointer events seen (diagnostics: physical = 0)
var blockedTypes: [UInt32: Int] = [:]
/// Where the cursor must stay (lock start, then wherever allowed events last put it).
var heldCursor: CGPoint?
func lockReport(_ why: String) -> String {
    json(["ended": why, "blocked": blocked, "passed": passed,
          "blocked_by_event_type": Dictionary(uniqueKeysWithValues: blockedTypes.map { (String($0.key), $0.value) }),
          "pointer_events_by_source_pid": Dictionary(uniqueKeysWithValues: pidCounts.map { (String($0.key), $0.value) })])
}

let lockCallback: CGEventTapCallBack = { _, type, event, _ in
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        if let t = lockTap { CGEvent.tapEnable(tap: t, enable: true) }
        return Unmanaged.passUnretained(event)
    }
    // EVERY event type is tapped (trackpad gesture phases, force touch, keys, media keys, …).
    let tag = event.getIntegerValueField(.eventSourceUserData)
    let pid = event.getIntegerValueField(.eventSourceUnixProcessID)
    pidCounts[pid, default: 0] += 1
    let isMove = [5, 6, 7, 27].contains(type.rawValue) // moved, left/right/other dragged
    if tag == eyeTag || tag == legacyTag || (allowSynthetic && pid != 0) {
        passed += 1
        if isMove || pointerTypes.contains(type.rawValue) { heldCursor = event.location }
        return Unmanaged.passUnretained(event)
    }
    blocked += 1
    blockedTypes[type.rawValue, default: 0] += 1
    if type == .keyDown, event.getIntegerValueField(.keyboardEventKeycode) == 53,
       event.getIntegerValueField(.keyboardEventAutorepeat) == 0 {
        let now = CACurrentMediaTime()
        escStreak = now - escLast < panicGap ? escStreak + 1 : 1
        escLast = now
        showEscStreak(escStreak)
        if escStreak >= panicCount {
            print(lockReport("escape"))
            exit(0)
        }
        // Streak expired: empty the dots again.
        DispatchQueue.main.asyncAfter(deadline: .now() + panicGap) {
            if CACurrentMediaTime() - escLast >= panicGap - 0.01 { escStreak = 0; showEscStreak(0) }
        }
    }
    // The window server moves the cursor itself before any tap sees the event: dropping the event stops clicks,
    // not the arrow. Put it straight back where the test left it.
    if isMove, let p = heldCursor { CGWarpMouseCursorPosition(p) }
    return nil
}

func cmdLock() {
    let seconds = min(opt("seconds").flatMap(Double.init) ?? 60, 600)
    let countdown = max(0, Int(opt("countdown") ?? "3") ?? 3)
    allowSynthetic = (opt("allow") ?? "synthetic") != "tagged"
    let mask: CGEventMask = ~CGEventMask(0)
    // Created up front (disabled) so a missing Accessibility permission fails before any countdown.
    guard let tap = CGEvent.tapCreate(tap: .cghidEventTap, place: .headInsertEventTap, options: .defaultTap,
                                      eventsOfInterest: mask, callback: lockCallback, userInfo: nil) else {
        fail("cannot create event tap — grant Accessibility permission to the host app")
    }
    CGEvent.tapEnable(tap: tap, enable: false)
    lockTap = tap
    CFRunLoopAddSource(CFRunLoopGetMain(), CFMachPortCreateRunLoopSource(nil, tap, 0), .commonModes)
    let end: (String) -> Void = { why in
        print(lockReport(why))
        exit(0)
    }
    onTerminate { end("signal") }
    let engage = {
        heldCursor = CGEvent(source: nil)?.location
        CGEvent.tapEnable(tap: tap, enable: true)
        // The overlay is only ever shown together with this full lock: orange on screen = no physical input gets through.
        showLockOverlay(until: Date().addingTimeInterval(seconds))
        // Backstop for movement that reaches the cursor without a tappable event: re-pin it every 8 ms.
        let pin = Timer(timeInterval: 0.008, repeats: true) { _ in
            guard let want = heldCursor, let now = CGEvent(source: nil)?.location else { return }
            if abs(now.x - want.x) > 0.5 || abs(now.y - want.y) > 0.5 { CGWarpMouseCursorPosition(want) }
        }
        RunLoop.main.add(pin, forMode: .common)
        // The TS side waits for this line before it drives anything.
        FileHandle.standardError.write("eye-capture: physical pointer + keyboard locked for \(seconds)s (Esc ×6 = emergency release)\n"
            .data(using: .utf8)!)
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { end("timeout") }
    }
    if countdown > 0 { showLockCountdown(from: countdown, step: 0.5, then: engage) } else { engage() }
}

/// Warning before a lock: a big "3 · 2 · 1" in the centre of every screen, one number per `step` seconds, input
/// still free. Excluded from sharing like the lock overlay.
func showLockCountdown(from n: Int, step: Double, then done: @escaping () -> Void) {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    app.finishLaunching()
    var numbers: [CATextLayer] = []
    var windows: [NSWindow] = []
    let orange = NSColor(srgbRed: 1, green: 0.55, blue: 0.1, alpha: 0.95)
    for screen in NSScreen.screens {
        let fr = screen.frame
        let w = NSWindow(contentRect: fr, styleMask: [.borderless], backing: .buffered, defer: false)
        w.isOpaque = false; w.backgroundColor = .clear; w.hasShadow = false
        w.ignoresMouseEvents = true
        w.level = .screenSaver
        w.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
        w.sharingType = .none
        w.animationBehavior = .none
        let v = NSView(frame: NSRect(origin: .zero, size: fr.size))
        v.wantsLayer = true
        let root = v.layer!
        let frameLayer = CALayer(); frameLayer.frame = CGRect(origin: .zero, size: fr.size)
        frameLayer.borderColor = orange.withAlphaComponent(0.6).cgColor; frameLayer.borderWidth = 3
        root.addSublayer(frameLayer)
        let disc = CALayer()
        disc.frame = CGRect(x: fr.width / 2 - 90, y: fr.height / 2 - 90, width: 180, height: 180)
        disc.cornerRadius = 90; disc.backgroundColor = NSColor(white: 0, alpha: 0.55).cgColor
        disc.borderColor = orange.cgColor; disc.borderWidth = 4
        root.addSublayer(disc)
        let num = CATextLayer()
        num.contentsScale = screen.backingScaleFactor
        num.alignmentMode = .center
        num.frame = CGRect(x: 0, y: 32, width: 180, height: 120)
        disc.addSublayer(num)
        numbers.append(num)
        let caption = "the-eye takes over trackpad & keyboard"
        let font = NSFont.systemFont(ofSize: 15, weight: .semibold)
        let cw = (caption as NSString).size(withAttributes: [.font: font]).width + 32
        let cap = CATextLayer()
        cap.string = NSAttributedString(string: caption, attributes: [.font: font, .foregroundColor: orange])
        cap.contentsScale = screen.backingScaleFactor
        cap.alignmentMode = .center
        cap.frame = CGRect(x: (fr.width - cw) / 2, y: fr.height / 2 - 130, width: cw, height: 22)
        root.addSublayer(cap)
        w.contentView = v
        w.orderFrontRegardless()
        windows.append(w)
    }
    let numberFont = NSFont.monospacedDigitSystemFont(ofSize: 96, weight: .heavy)
    func show(_ k: Int) {
        for l in numbers {
            l.string = NSAttributedString(string: "\(k)", attributes: [.font: numberFont, .foregroundColor: orange])
            let pop = CABasicAnimation(keyPath: "transform.scale")
            pop.fromValue = 1.35; pop.toValue = 1; pop.duration = min(0.25, step / 2)
            pop.timingFunction = CAMediaTimingFunction(name: .easeOut)
            l.add(pop, forKey: "pop")
        }
    }
    for i in 0..<n {
        DispatchQueue.main.asyncAfter(deadline: .now() + Double(i) * step) {
            CATransaction.begin(); CATransaction.setDisableActions(true); show(n - i); CATransaction.commit()
        }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + Double(n) * step) {
        windows.forEach { $0.orderOut(nil) }
        done()
    }
}

/// Tells the user a test owns their input: a translucent orange wash over every screen, a breathing edge glow, a
/// sweeping sheen, a frame, and a bottom-centre pill with a pulsing dot. Click-through, every Space, every display,
/// and excluded from sharing, so screen captures never see it (it never adds pixels to a measurement).
var lockOverlayWindows: [NSWindow] = []
let escDotPitch: CGFloat = 14
/// Per screen: the pill, its Esc-progress dots, and the "keep pressing" hint above it.
var escFeedback: [(pill: CALayer, dots: [CALayer], hint: CATextLayer)] = []

/// Shows how far the user is into the Esc emergency release (0 = idle).
func showEscStreak(_ n: Int) {
    CATransaction.begin()
    CATransaction.setAnimationDuration(0.12)
    let hintFont = NSFont.systemFont(ofSize: 14, weight: .bold)
    let left = panicCount - n
    let hintText = left <= 1 ? "Esc once more to release" : "Esc \(n)/\(panicCount) · \(left) more to release"
    for f in escFeedback {
        for (i, d) in f.dots.enumerated() {
            d.backgroundColor = i < n ? NSColor.black.cgColor : NSColor.clear.cgColor
        }
        f.hint.string = NSAttributedString(string: hintText, attributes: [
            .font: hintFont, .foregroundColor: NSColor(srgbRed: 1, green: 0.6, blue: 0.15, alpha: 1),
            .strokeColor: NSColor.black, .strokeWidth: -3,
        ])
        f.hint.opacity = n > 0 ? 1 : 0
        if n > 0 {
            let pop = CABasicAnimation(keyPath: "transform.scale")
            pop.fromValue = 1.08; pop.toValue = 1; pop.duration = 0.18
            pop.timingFunction = CAMediaTimingFunction(name: .easeOut)
            f.pill.add(pop, forKey: "esc")
            if n - 1 < f.dots.count {
                let dp = CABasicAnimation(keyPath: "transform.scale")
                dp.fromValue = 1.8; dp.toValue = 1; dp.duration = 0.2
                f.dots[n - 1].add(dp, forKey: "esc")
            }
        }
    }
    CATransaction.commit()
}

func showLockOverlay(until: Date) {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    app.finishLaunching()
    let f = DateFormatter(); f.dateFormat = "HH:mm:ss"
    let message = "the-eye is testing — trackpad & keyboard locked until \(f.string(from: until)) · Esc ×\(panicCount) releases"
    let orange = NSColor(srgbRed: 1, green: 0.55, blue: 0.1, alpha: 0.95).cgColor
    for screen in NSScreen.screens {
        let fr = screen.frame
        let w = NSWindow(contentRect: fr, styleMask: [.borderless], backing: .buffered, defer: false)
        w.isOpaque = false; w.backgroundColor = .clear; w.hasShadow = false
        w.ignoresMouseEvents = true
        w.level = .screenSaver
        w.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
        w.sharingType = .none
        w.animationBehavior = .none
        let v = NSView(frame: NSRect(origin: .zero, size: fr.size))
        v.wantsLayer = true
        let root = v.layer!
        let bounds = CGRect(origin: .zero, size: fr.size)
        let tint = { (a: CGFloat) in NSColor(srgbRed: 1, green: 0.5, blue: 0.08, alpha: a).cgColor }
        // Every effect below is a Core Animation layer animation: it runs in the render server, so this process
        // spends no CPU per frame, and the window is excluded from screen captures (sharingType .none).
        let wash = CALayer(); wash.frame = bounds; wash.backgroundColor = tint(0.12); root.addSublayer(wash)
        // Edge glow that breathes.
        let glow = CAGradientLayer(); glow.frame = bounds; glow.type = .radial
        glow.startPoint = CGPoint(x: 0.5, y: 0.5); glow.endPoint = CGPoint(x: 1.05, y: 1.05)
        glow.colors = [tint(0), tint(0.05), tint(0.42)]; glow.locations = [0, 0.55, 1]
        root.addSublayer(glow)
        let breathe = CABasicAnimation(keyPath: "opacity")
        breathe.fromValue = 0.45; breathe.toValue = 1; breathe.duration = 1.6
        breathe.autoreverses = true; breathe.repeatCount = .infinity
        breathe.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        glow.add(breathe, forKey: "breathe")
        // A soft diagonal sheen that sweeps across every few seconds.
        let band = max(fr.width, fr.height) * 0.45
        let sheen = CAGradientLayer()
        sheen.bounds = CGRect(x: 0, y: 0, width: band, height: hypot(fr.width, fr.height) * 1.2)
        sheen.startPoint = CGPoint(x: 0, y: 0.5); sheen.endPoint = CGPoint(x: 1, y: 0.5)
        sheen.colors = [NSColor(white: 1, alpha: 0).cgColor, NSColor(srgbRed: 1, green: 0.85, blue: 0.6, alpha: 0.10).cgColor,
                        NSColor(white: 1, alpha: 0).cgColor]
        sheen.position = CGPoint(x: -band, y: fr.height / 2)
        sheen.transform = CATransform3DMakeRotation(-.pi / 9, 0, 0, 1)
        root.addSublayer(sheen)
        let sweep = CABasicAnimation(keyPath: "position.x")
        sweep.fromValue = -band; sweep.toValue = fr.width + band; sweep.duration = 2.4
        sweep.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        let sweepGroup = CAAnimationGroup(); sweepGroup.animations = [sweep]; sweepGroup.duration = 4.2
        sweepGroup.repeatCount = .infinity
        sheen.add(sweepGroup, forKey: "sweep")
        // Frame on all four edges.
        let frameLayer = CALayer(); frameLayer.frame = bounds
        frameLayer.borderColor = orange; frameLayer.borderWidth = 4
        root.addSublayer(frameLayer)
        // Bottom pill with a pulsing dot.
        let font = NSFont.systemFont(ofSize: 13, weight: .semibold)
        let textW = (message as NSString).size(withAttributes: [.font: font]).width
        let pill = CALayer()
        let escW = CGFloat(panicCount) * escDotPitch + 4
        pill.frame = CGRect(x: (fr.width - textW - 56 - escW) / 2, y: 22, width: textW + 56 + escW, height: 32)
        pill.backgroundColor = orange; pill.cornerRadius = 16
        pill.shadowColor = tint(1); pill.shadowOpacity = 0.8; pill.shadowRadius = 14; pill.shadowOffset = .zero
        pill.shadowPath = CGPath(roundedRect: pill.bounds, cornerWidth: 16, cornerHeight: 16, transform: nil)
        let dot = CALayer()
        dot.frame = CGRect(x: 14, y: 11, width: 10, height: 10); dot.cornerRadius = 5
        dot.backgroundColor = NSColor.black.cgColor
        let pulse = CABasicAnimation(keyPath: "transform.scale")
        pulse.fromValue = 0.6; pulse.toValue = 1.15; pulse.duration = 0.8
        pulse.autoreverses = true; pulse.repeatCount = .infinity
        pulse.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        dot.add(pulse, forKey: "pulse")
        pill.addSublayer(dot)
        let text = CATextLayer()
        text.string = NSAttributedString(string: message, attributes: [.font: font, .foregroundColor: NSColor.black])
        text.contentsScale = screen.backingScaleFactor
        text.alignmentMode = .center
        text.frame = CGRect(x: 30, y: 8, width: textW + 14, height: 18)
        pill.addSublayer(text)
        // Emergency-release progress: one ring per Esc press needed, filled as the streak grows.
        var dots: [CALayer] = []
        for i in 0..<panicCount {
            let d = CALayer()
            d.frame = CGRect(x: textW + 50 + CGFloat(i) * escDotPitch, y: 11.5, width: 9, height: 9)
            d.cornerRadius = 4.5; d.borderWidth = 1.5; d.borderColor = NSColor.black.cgColor
            pill.addSublayer(d)
            dots.append(d)
        }
        let hint = CATextLayer()
        hint.contentsScale = screen.backingScaleFactor
        hint.alignmentMode = .center
        hint.frame = CGRect(x: 0, y: pill.frame.maxY + 10, width: fr.width, height: 22)
        hint.opacity = 0
        root.addSublayer(hint)
        root.addSublayer(pill)
        escFeedback.append((pill, dots, hint))
        w.contentView = v
        w.orderFrontRegardless()
        lockOverlayWindows.append(w)
    }
}

// MARK: - input actor
//
// `input` reads one JSON command per stdin line and answers one JSON line when it has finished:
//   {"op":"move","x":..,"y":..,"ms":300}         glide from the current pointer (ms 0 = jump)
//   {"op":"click","x"?,"y"?,"button":"left|right","count":1,"hold_ms":60}
//   {"op":"down"|"up","button":"left"}             press / release (drag = down, move, up)
//   {"op":"scroll","dy":-5,"dx":0,"events":30,"interval_ms":8,"phased":true}
//                                                   phased = trackpad-style began/changed/ended
//   {"op":"pos"}                                    current pointer position
//   {"op":"owner","x"?,"y"?}                         topmost window under a point {pid, owner, layer, number}
//   {"op":"inspect","x"?,"y"?,"brief"?}              AX element under a point (everything it exposes) + its window
//   {"op":"tree","rect"?:[x,y,w,h],"display"?,"x"?,"y"?,"process"?,"mode":"basic|full","depth"?,"max_nodes"?,"limit"?,"clip"?,"out"?}
//                                                   AX element tree (with frames) of the windows in a display-local rect,
//                                                   or of the single window under a point; full JSON to `out`
// click/down accept "require_pid": the press is refused unless that pid owns the topmost window there.
// All events carry eventSourceUserData 0x45594521 so they pass eye-capture's input lock.
func cmdInput() {
    setvbuf(stdout, nil, _IOLBF, 0)
    let src = CGEventSource(stateID: .hidSystemState)
    var buttonsDown = Set<String>()
    func pointer() -> CGPoint { CGEvent(source: nil)?.location ?? .zero }
    func send(_ e: CGEvent?) {
        guard let e else { return }
        e.setIntegerValueField(.eventSourceUserData, value: eyeTag)
        e.post(tap: .cghidEventTap)
    }
    func mouseType(_ button: String, down: Bool) -> (CGEventType, CGMouseButton) {
        button == "right" ? (down ? .rightMouseDown : .rightMouseUp, .right) : (down ? .leftMouseDown : .leftMouseUp, .left)
    }
    func moveEvent(_ p: CGPoint) {
        let type: CGEventType = buttonsDown.contains("left") ? .leftMouseDragged : buttonsDown.contains("right") ? .rightMouseDragged : .mouseMoved
        send(CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: p, mouseButton: buttonsDown.contains("right") ? .right : .left))
    }
    func reply(_ o: [String: Any]) { print(json(o)) }
    /// A press with `require_pid` is only posted when that process owns the topmost window at the point.
    func pressAllowed(_ c: [String: Any], at p: CGPoint) -> String? {
        guard let want = (c["require_pid"] as? NSNumber)?.intValue else { return nil }
        let o = topWindow(at: p)
        let got = (o?["pid"] as? NSNumber)?.intValue ?? (o?["pid"] as? Int) ?? -1
        return got == want ? nil : "REFUSED press at \(Int(p.x)),\(Int(p.y)): topmost window belongs to \(o?["owner"] ?? "nothing") (pid \(got)), not pid \(want)"
    }
    while let line = readLine() {
        guard let d = line.data(using: .utf8), let c = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
              let op = c["op"] as? String else { reply(["ok": false, "error": "bad command"]); continue }
        let num = { (k: String, def: Double) -> Double in (c[k] as? NSNumber)?.doubleValue ?? def }
        let t0 = Date()
        switch op {
        case "move":
            let from = pointer(), to = CGPoint(x: num("x", from.x), y: num("y", from.y))
            let ms = num("ms", 300), steps = max(1, Int(ms / 8))
            for i in 1...steps {
                let t = CGFloat(i) / CGFloat(steps)
                moveEvent(CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t))
                if ms > 0 { usleep(8000) }
            }
        case "click":
            if c["x"] != nil || c["y"] != nil { let p = pointer(); moveEvent(CGPoint(x: num("x", p.x), y: num("y", p.y))); usleep(16000) }
            if let why = pressAllowed(c, at: pointer()) { reply(["ok": false, "error": why]); continue }
            let (dn, btn) = mouseType(c["button"] as? String ?? "left", down: true)
            let (up, _) = mouseType(c["button"] as? String ?? "left", down: false)
            for i in 1...max(1, Int(num("count", 1))) {
                let p = pointer()
                let e1 = CGEvent(mouseEventSource: src, mouseType: dn, mouseCursorPosition: p, mouseButton: btn)
                e1?.setIntegerValueField(.mouseEventClickState, value: Int64(i)); send(e1)
                usleep(useconds_t(num("hold_ms", 60) * 1000))
                let e2 = CGEvent(mouseEventSource: src, mouseType: up, mouseCursorPosition: p, mouseButton: btn)
                e2?.setIntegerValueField(.mouseEventClickState, value: Int64(i)); send(e2)
                usleep(40000)
            }
        case "down", "up":
            let b = c["button"] as? String ?? "left"
            if op == "down", let why = pressAllowed(c, at: pointer()) { reply(["ok": false, "error": why]); continue }
            // Never send a release for a press this actor didn't make (it would land on whatever is under the pointer).
            if op == "up", !buttonsDown.contains(b) {
                let p = pointer()
                reply(["ok": true, "op": op, "x": p.x, "y": p.y, "ms": 0, "skipped": "button not held"]); continue
            }
            let (type, btn) = mouseType(b, down: op == "down")
            send(CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: pointer(), mouseButton: btn))
            if op == "down" { buttonsDown.insert(b) } else { buttonsDown.remove(b) }
        case "scroll":
            let dy = Int32(num("dy", 0)), dx = Int32(num("dx", 0)), n = max(1, Int(num("events", 20)))
            let iv = useconds_t(num("interval_ms", 8) * 1000), phased = (c["phased"] as? Bool) ?? true
            func post(_ phase: Int64, _ y: Int32, _ x: Int32) {
                guard let e = CGEvent(scrollWheelEvent2Source: src, units: .pixel, wheelCount: 2, wheel1: y, wheel2: x, wheel3: 0) else { return }
                if phased {
                    e.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
                    e.setIntegerValueField(.scrollWheelEventScrollPhase, value: phase)
                }
                e.location = pointer()
                send(e)
            }
            if phased { post(1, 0, 0); usleep(iv) }
            for _ in 0..<n { post(2, dy, dx); usleep(iv) }
            if phased { post(4, 0, 0) }
        case "pos": break
        case "inspect":
            // The element under a point (default: the pointer) — everything it exposes — plus the window there.
            let p = CGPoint(x: num("x", pointer().x), y: num("y", pointer().y))
            var o: [String: Any] = ["ok": true, "op": op, "x": p.x, "y": p.y]
            if !AXIsProcessTrusted() { o["ok"] = false; o["error"] = "Accessibility permission missing for the host app"; reply(o); continue }
            if let el = AXI.hit(p) {
                let info = AXI.inspect(el)
                // brief (eye_act, per step): drop the attribute dump and ancestor list, keep the rest.
                o["element"] = (c["brief"] as? Bool) == true ? info.filter { $0.key != "attributes" && $0.key != "ancestors" && $0.key != "parameterized_attributes" } : info
            } else { o["element"] = NSNull() }
            o["cg_window"] = topWindow(at: p) ?? NSNull()
            reply(o); continue
        case "tree":
            // Element tree of the windows intersecting a display-local rect (or the window under a point).
            if !AXIsProcessTrusted() { reply(["ok": false, "error": "Accessibility permission missing for the host app"]); continue }
            var rect: CGRect
            var limit = Int(num("limit", 4))
            var process = c["process"] as? String
            if let r = c["rect"] as? [NSNumber], r.count == 4 {
                let origin = (c["display"] as? NSNumber).map { CGDisplayBounds($0.uint32Value).origin } ?? .zero
                rect = CGRect(x: r[0].doubleValue + origin.x, y: r[1].doubleValue + origin.y, width: r[2].doubleValue, height: r[3].doubleValue)
            } else {
                // The window under a point: AX hit-test (CG's topmost window can be a transparent full-screen one).
                let p = CGPoint(x: num("x", pointer().x), y: num("y", pointer().y))
                guard let el = AXI.hit(p) else { reply(["ok": false, "error": "no accessibility element at \(Int(p.x)),\(Int(p.y))"]); continue }
                let root = AXI.windowRoot(of: el)
                rect = AXI.frame(AXI.many(root, [kAXPositionAttribute, kAXSizeAttribute])) ?? CGRect(x: p.x, y: p.y, width: 1, height: 1)
                process = process ?? String(AXI.pid(el)); limit = 1
            }
            let full = (c["mode"] as? String) == "full"
            var o = AXI.tree(rect: rect, process: process, full: full, clip: (c["clip"] as? Bool) ?? (c["rect"] != nil),
                             maxDepth: Int(num("depth", full ? 60 : 40)), maxNodes: Int(num("max_nodes", full ? 2000 : 250)), limit: limit)
            if let out = c["out"] as? String { try? json(o).write(toFile: out, atomically: true, encoding: .utf8) }
            o.removeValue(forKey: "windows")
            o["ok"] = true; o["op"] = op; o["rect"] = [rect.minX, rect.minY, rect.width, rect.height]
            reply(o); continue
        case "owner":
            let p = CGPoint(x: num("x", pointer().x), y: num("y", pointer().y))
            var o = topWindow(at: p) ?? [:]
            o["ok"] = true; o["op"] = op; o["x"] = p.x; o["y"] = p.y
            reply(o); continue
        default:
            reply(["ok": false, "error": "unknown op \(op)"]); continue
        }
        let p = pointer()
        reply(["ok": true, "op": op, "x": p.x, "y": p.y, "ms": Int(Date().timeIntervalSince(t0) * 1000)])
    }
    exit(0)
}

// MARK: - main

switch sub {
case "input": cmdInput()
case "displays": Task { await cmdDisplays() }
case "snapshot": Task { await cmdSnapshot() }
case "capture": Task { await cmdCapture() }
case "lock": cmdLock()
default:
    print("usage: eye-capture displays | capture --rect x,y,w,h --out f.csv [--seconds N] | snapshot --rect x,y,w,h --out f.png | lock [--seconds N]")
    exit(sub.isEmpty ? 1 : 2)
}
// CFRunLoopRun (not dispatchMain): the lock's event tap is a run-loop source, and the main run
// loop also drains the main dispatch queue the other subcommands use.
CFRunLoopRun()
