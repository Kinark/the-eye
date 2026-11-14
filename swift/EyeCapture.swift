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
//   watch    [--app NAME]... [--until TEXT]... [--seconds N] [--values] [--json]
//            One line per UI event (AXObserver + NSWorkspace) until killed or --until matches; see watch --help.
//
// Coordinates: display-local POINTS, top-left origin.
import AppKit
import CoreMedia
import ImageIO
import IOKit.hid
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

/// What shows behind an app recorded on its own. SCStreamConfiguration.backgroundColor is an `assign` property: it
/// does not keep the colour alive, so this has to outlive every stream (a temporary there is a crash waiting).
let captureBackdrop = CGColor(gray: 0.5, alpha: 1)

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

/// The image as tightly packed 8-bit sRGB RGBA (no header), for the maths on a still frame (src/still.ts).
func writeRaw(_ img: CGImage, _ path: String) -> Bool {
    let w = img.width, h = img.height
    guard let cs = CGColorSpace(name: CGColorSpace.sRGB),
          let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: cs,
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
          let base = { ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h)); return ctx.data }() else { return false }
    return FileManager.default.createFile(atPath: path, contents: Data(bytesNoCopy: base, count: w * h * 4, deallocator: .none))
}

/// `raw --in image.png --out file.rgba`: an existing image (a keyframe, a fallback screenshot) as raw sRGB RGBA.
func cmdRaw() {
    guard let src = opt("in"), let out = opt("out") else { fail("raw needs --in image --out file.rgba") }
    guard let s = CGImageSourceCreateWithURL(URL(fileURLWithPath: src) as CFURL, nil),
          let img = CGImageSourceCreateImageAtIndex(s, 0, nil) else { fail("cannot read \(src)") }
    guard writeRaw(img, out) else { fail("could not write \(out)") }
    print(json(["path": out, "pixels": ["w": img.width, "h": img.height]]))
    exit(0)
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
        if let raw = opt("raw"), !writeRaw(img, raw) { fail("could not write \(raw)") }
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
        buf = "t,status,interval_ms,diff,changed_frac,mean_luma,bbox_x0,bbox_y0,bbox_x1,bbox_y1,bbox_w,bbox_h,anch_w,anch_h,anch_cx,mv_x0,mv_y0,mv_x1,mv_y1,mv_cx,mv_cy\n"
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
        // What moved since the previous frame (not since the first): its box and its centre of change. A thing that
        // slides, or shrinks, leaves the first-frame box untouched but shows up here; a change that happened once and
        // stayed (a pressed button, a title bar) does not.
        var mx0 = Int.max, my0 = Int.max, mx1 = -1, my1 = -1, mW = 0, mX = 0, mY = 0
        let hasPrev = prev?.count == luma.count
        luma.withUnsafeBufferPointer { L in
            base!.withUnsafeBufferPointer { B in
                for i in 0..<L.count {
                    if hasPrev {
                        let d = abs(Int(L[i]) - Int(prev![i]))
                        diffSum += d
                        if d > 8 {
                            changed += 1
                            let x = i % gw, y = i / gw
                            if x < mx0 { mx0 = x }; if x > mx1 { mx1 = x }
                            if y < my0 { my0 = y }; if y > my1 { my1 = y }
                            mW += d; mX += d * x; mY += d * y
                        }
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
        let mv = mx1 >= 0
        buf += String(format: "%.5f,c,%.3f,%.3f,%.5f,%.2f,%.1f,%.1f,%.1f,%.1f,%.1f,%.1f,%.1f,%.1f,%.1f,%.1f,%.1f,%.1f,%.1f,%.2f,%.2f\n",
                      rel, interval, hasPrev ? Double(diffSum) / n : 0, hasPrev ? Double(changed) / n : 0,
                      Double(lumaSum) / n, bx0, by0, bx1, by1, bx1 - bx0, by1 - by0,
                      ax0 >= 0 ? ax1 - ax0 : 0, adepth, ax0 >= 0 ? (ax0 + ax1) / 2 : 0,
                      mv ? Double(mx0) * k : 0, mv ? Double(my0) * k : 0, mv ? Double(mx1 + 1) * k : 0, mv ? Double(my1 + 1) * k : 0,
                      mv ? (Double(mX) / Double(mW) + 0.5) * k : 0, mv ? (Double(mY) / Double(mW) + 0.5) * k : 0)
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
    // The limiter is given half a frame of slack. Asked for exactly one frame per refresh it throws away every frame
    // that arrives a hair early (display times jitter by microseconds), and a perfectly smooth 120Hz animation is
    // recorded as ~97 fps with "late" frames it never had. At 1.5× the asked rate every refresh still gets through,
    // and a lower rate (60 on a 120Hz display) still gets every second one.
    cfg.minimumFrameInterval = CMTime(value: 2, timescale: CMTimeScale(max(1, (fps * 3).rounded())))
    cfg.queueDepth = 8
    cfg.pixelFormat = kCVPixelFormatType_32BGRA
    cfg.showsCursor = false
    // --only-pid: record that app's windows alone (the ones it has now and the ones it opens), over mid grey. Otherwise
    // whatever shows through a see-through window, or sits over the app (another app's window, the input-lock
    // overlay), is measured as if it were the app's own motion.
    var filter = SCContentFilter(display: d, excludingWindows: [])
    if let pid = opt("only-pid").flatMap(Int32.init) {
        if let app = content.applications.first(where: { $0.processID == pid }) {
            filter = SCContentFilter(display: d, including: [app], exceptingWindows: [])
            // Mid grey behind it, not the default clear (which lands as black): a black shape growing over nothing
            // but black cannot be seen to move at all, and neither can a white one over white.
            cfg.backgroundColor = captureBackdrop
        } else {
            FileHandle.standardError.write("eye-capture: --only-pid \(pid) is not an app ScreenCaptureKit can single out; recording everything in the rect\n".data(using: .utf8)!)
        }
    }
    let stream = SCStream(filter: filter, configuration: cfg, delegate: rec)
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
/// Where the cursor should be (lock start, then wherever allowed events last put it). Read-only: only used to
/// measure `max_cursor_drift_pt`, the cursor is never warped back.
var heldCursor: CGPoint?
/// True once the countdown is over. Until then the tap stays off: disabling a fresh tap delivers a
/// tapDisabledByUserInput callback, and re-enabling on that used to arm the lock in the middle of the 3·2·1.
var lockEngaged = false
/// Largest distance (pt) the cursor got from where it should be, sampled on every blocked physical move.
var maxDrift = 0.0
/// The window server moves the arrow before any event tap sees the motion, so the tap alone stops clicks but not
/// the cursor. The lock therefore seizes every pointing device at the HID level: the device's reports go to us
/// instead of the window server, and the arrow never hears about the finger. Trackpad gesture/touch events come
/// through a separate multitouch path (exclusively held by the system) and are dropped by the tap as before.
/// The kernel releases a seize when the process dies, so a killed lock can't strand the trackpad.
let pointerHID = IOHIDManagerCreate(kCFAllocatorDefault, IOOptionBits(kIOHIDOptionsTypeNone))
var seizedDevices: [IOHIDDevice] = []
let seizeOption = IOOptionBits(kIOHIDOptionsTypeSeizeDevice)
func matchPointers() {
    IOHIDManagerSetDeviceMatchingMultiple(pointerHID, [
        [kIOHIDDeviceUsagePageKey: kHIDPage_GenericDesktop, kIOHIDDeviceUsageKey: kHIDUsage_GD_Mouse],
        [kIOHIDDeviceUsagePageKey: kHIDPage_GenericDesktop, kIOHIDDeviceUsageKey: kHIDUsage_GD_Pointer],
        [kIOHIDDeviceUsagePageKey: kHIDPage_Digitizer],
    ] as CFArray)
}
func pointerDevices() -> [IOHIDDevice] {
    (IOHIDManagerCopyDevices(pointerHID) as? Set<IOHIDDevice>).map(Array.init) ?? []
}
func hidName(_ d: IOHIDDevice) -> String {
    (IOHIDDeviceGetProperty(d, kIOHIDProductKey as CFString) as? String) ?? "pointing device"
}
func hidError(_ r: IOReturn) -> String {
    switch r {
    case kIOReturnExclusiveAccess: return "another process holds it exclusively"
    case kIOReturnNotPermitted, kIOReturnNotPrivileged: return "not permitted (Input Monitoring / Accessibility for the host app?)"
    default: return String(format: "IOReturn 0x%08x", r)
    }
}
/// Other `eye-capture lock` processes: two locks fight over the HID seize and the second one silently loses.
func otherLockPids() -> [Int32] {
    let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep"); p.arguments = ["-f", "eye-capture lock"]
    let pipe = Pipe(); p.standardOutput = pipe; p.standardError = FileHandle.nullDevice
    guard (try? p.run()) != nil else { return [] }
    p.waitUntilExit()
    let s = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    return s.split(separator: "\n").compactMap { Int32($0) }.filter { $0 != getpid() }
}
/// Everything that can make a lock fail, checked BEFORE the countdown: the tap must actually turn on, and every
/// pointing device must accept a seize (each is seized and released again at once, only while no button is held,
/// so a press can't lose its release in that instant). Returns the problems, empty = good to go.
func lockPreflight(_ tap: CFMachPort) -> [String] {
    var problems: [String] = []
    CGEvent.tapEnable(tap: tap, enable: true)
    if !CGEvent.tapIsEnabled(tap: tap) { problems.append("the event tap would not turn on (Accessibility permission for the host app?)") }
    let others = otherLockPids()
    if !others.isEmpty { problems.append("another eye-capture lock is already running (pid \(others.map(String.init).joined(separator: ", "))) — it holds the pointing devices") }
    matchPointers()
    // A held press is left alone (seizing now could eat its release); engage seizes for real and reports a refusal.
    // Exactly what engage does (hold every device at once), then let go again.
    if physicalButtons().isEmpty {
        let (held, refused) = seizeAll()
        for d in held { IOHIDDeviceClose(d, seizeOption) }
        problems += refused.map { "cannot seize \($0)" }
    }
    return problems
}
/// Seize every pointing device now (synchronously, so "locked" is never printed before the arrow is pinned), and
/// any mouse plugged in or paired mid-lock later. Returns the devices that refused.
/// One physical device (the built-in keyboard/trackpad) shows up as several IOHIDDevice handles, one per interface.
/// Seizing one makes its siblings answer "exclusive access" — that device is ours already, not a failure. Only a
/// physical device with NO seized handle counts as refused.
func hidPhysical(_ d: IOHIDDevice) -> String {
    let loc = IOHIDDeviceGetProperty(d, kIOHIDLocationIDKey as CFString) as? NSNumber
    let vid = IOHIDDeviceGetProperty(d, kIOHIDVendorIDKey as CFString) as? NSNumber
    let pid = IOHIDDeviceGetProperty(d, kIOHIDProductIDKey as CFString) as? NSNumber
    return "\(loc ?? 0)/\(vid ?? 0)/\(pid ?? 0)/\(hidName(d))"
}
func seizeAll(skip: [IOHIDDevice] = []) -> (held: [IOHIDDevice], refused: [String]) {
    var held: [IOHIDDevice] = [], failed: [String: String] = [:]
    var covered = Set(skip.map(hidPhysical))
    for d in pointerDevices() where !skip.contains(d) {
        let key = hidPhysical(d)
        let r = IOHIDDeviceOpen(d, seizeOption)
        if r == kIOReturnSuccess { held.append(d); covered.insert(key); failed[key] = nil }
        else if !covered.contains(key) { failed[key] = "\(hidName(d)): \(hidError(r))" }
    }
    return (held, failed.filter { !covered.contains($0.key) }.map(\.value))
}
func seizePointers() -> [String] {
    matchPointers()
    let (held, refused) = seizeAll(skip: seizedDevices)
    seizedDevices += held
    IOHIDManagerRegisterDeviceMatchingCallback(pointerHID, { _, _, _, device in
        guard !seizedDevices.contains(device), IOHIDDeviceOpen(device, seizeOption) == kIOReturnSuccess else { return }
        seizedDevices.append(device)
    }, nil)
    IOHIDManagerScheduleWithRunLoop(pointerHID, CFRunLoopGetMain(), CFRunLoopMode.commonModes.rawValue)
    return refused
}
func physicalButtons() -> [CGMouseButton] {
    [CGMouseButton.left, .right, .center].filter { CGEventSource.buttonState(.hidSystemState, button: $0) }
}
/// What the user's hands were doing as the lock engaged (seen by the tap while it still let everything through):
/// a scroll or fling still running, a gesture in the middle. Cut off by the lock, these would leave apps waiting
/// for an end that never comes, so the lock ends them itself.
var physScrollOpen = false, physMomentumOpen = false
var physLastScroll = 0.0, physLastGesture = 0.0
var interrupted: [String] = []
var settleMs = 0
func releasePointers() {
    IOHIDManagerUnscheduleFromRunLoop(pointerHID, CFRunLoopGetMain(), CFRunLoopMode.commonModes.rawValue)
    for d in seizedDevices { IOHIDDeviceClose(d, seizeOption) }
    seizedDevices.removeAll()
}
func lockReport(_ why: String) -> String {
    let seized = seizedDevices.count
    releasePointers()
    CGAssociateMouseAndMouseCursorPosition(1) // older builds disassociated the cursor; never leave it cut off
    var o: [String: Any] = ["ended": why, "style": lockStyle, "blocked": blocked, "passed": passed, "pointer_devices_seized": seized,
          "max_cursor_drift_pt": (maxDrift * 1000).rounded() / 1000, "settle_ms": settleMs,
          "blocked_by_event_type": Dictionary(uniqueKeysWithValues: blockedTypes.map { (String($0.key), $0.value) }),
          "pointer_events_by_source_pid": Dictionary(uniqueKeysWithValues: pidCounts.map { (String($0.key), $0.value) })]
    if !interrupted.isEmpty { o["interrupted_at_engage"] = interrupted }
    return json(o)
}

/// "full": the 3·2·1 warning, then the orange wash. "quick" ("Just a sec…"): no countdown, a small pill at the top —
/// for a glance of a second or two (raise a window, look, put it back).
var lockStyle = "full"

let lockCallback: CGEventTapCallBack = { _, type, event, _ in
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        // Re-enabling is always safe: before engaging, the callback below lets everything through.
        if let t = lockTap { CGEvent.tapEnable(tap: t, enable: true) }
        return Unmanaged.passUnretained(event)
    }
    // EVERY event type is tapped (trackpad gesture phases, force touch, keys, media keys, …).
    let tag = event.getIntegerValueField(.eventSourceUserData)
    let pid = event.getIntegerValueField(.eventSourceUnixProcessID)
    if !lockEngaged {
        // Countdown / settling: hands-off observer. Nothing is blocked or counted; only remember what a physical
        // scroll, fling or gesture is in the middle of, so engaging can wait for it or end it cleanly.
        if pid == 0, tag != eyeTag {
            let now = CACurrentMediaTime()
            if type == .scrollWheel {
                let ph = event.getIntegerValueField(.scrollWheelEventScrollPhase)
                let mo = event.getIntegerValueField(.scrollWheelEventMomentumPhase)
                if ph != 0 { physScrollOpen = ph == 1 || ph == 2 || ph == 128 }
                if mo != 0 { physMomentumOpen = mo == 1 || mo == 2 }
                physLastScroll = now
            } else if [18, 30, 31].contains(type.rawValue) {
                physLastGesture = now // rotate / magnify / swipe (not 29: resting fingers fire those too)
            }
        }
        return Unmanaged.passUnretained(event)
    }
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
        if escStreak >= panicCount { lockEnd?("escape") }
        // Streak expired: empty the dots again.
        DispatchQueue.main.asyncAfter(deadline: .now() + panicGap) {
            if CACurrentMediaTime() - escLast >= panicGap - 0.01 { escStreak = 0; showEscStreak(0) }
        }
    }
    if isMove, let want = heldCursor, let now = CGEvent(source: nil)?.location {
        maxDrift = max(maxDrift, hypot(now.x - want.x, now.y - want.y))
    }
    return nil
}
var lockEnd: ((String) -> Void)?

/// Why engaging right now would cut the user off mid-action, or nil when their hands are idle.
func handsBusy() -> String? {
    let held = physicalButtons()
    if !held.isEmpty { return held.contains(.left) ? "left button held (drag?)" : "button held" }
    let now = CACurrentMediaTime()
    if (physScrollOpen || physMomentumOpen) && now - physLastScroll < 0.3 { return physMomentumOpen ? "scroll momentum" : "scrolling" }
    if now - physLastGesture < 0.15 { return "gesture" }
    return nil
}

/// Engaging while the user was mid-drag / mid-scroll would strand that action: the seize swallows the release, so the
/// window server keeps the button down and the app stays in its drag loop (eating our events). End each one cleanly,
/// with tagged events the tap lets through.
func endInterruptedActions() {
    let src = CGEventSource(stateID: .hidSystemState)
    let at = CGEvent(source: nil)?.location ?? .zero
    func post(_ e: CGEvent?) { guard let e else { return }; e.setIntegerValueField(.eventSourceUserData, value: eyeTag); e.post(tap: .cghidEventTap) }
    for b in physicalButtons() {
        let (type, name): (CGEventType, String) = b == .left ? (.leftMouseUp, "left drag") : b == .right ? (.rightMouseUp, "right drag") : (.otherMouseUp, "other-button drag")
        post(CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: at, mouseButton: b))
        interrupted.append("\(name) released at \(Int(at.x)),\(Int(at.y))")
    }
    let now = CACurrentMediaTime()
    if physScrollOpen && now - physLastScroll < 1 {
        let e = CGEvent(scrollWheelEvent2Source: src, units: .pixel, wheelCount: 2, wheel1: 0, wheel2: 0, wheel3: 0)
        e?.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1); e?.setIntegerValueField(.scrollWheelEventScrollPhase, value: 4)
        e?.location = at; post(e); interrupted.append("scroll ended")
    }
    if physMomentumOpen && now - physLastScroll < 1 {
        let e = CGEvent(scrollWheelEvent2Source: src, units: .pixel, wheelCount: 2, wheel1: 0, wheel2: 0, wheel3: 0)
        e?.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1); e?.setIntegerValueField(.scrollWheelEventMomentumPhase, value: 3)
        e?.location = at; post(e); interrupted.append("scroll momentum ended")
    }
}

func cmdLock() {
    setvbuf(stdout, nil, _IOLBF, 0)
    var seconds = min(opt("seconds").flatMap(Double.init) ?? 60, 600)
    lockStyle = opt("style") == "quick" ? "quick" : "full"
    let countdown = max(0, Int(opt("countdown") ?? (lockStyle == "quick" ? "0" : "3")) ?? 3)
    // How long to wait (after any countdown) for a drag / scroll / gesture in progress to finish before engaging anyway.
    let settleMax = (opt("settle-ms").flatMap(Double.init) ?? 1200) / 1000
    let message = opt("message") ?? "Just a sec…"
    allowSynthetic = (opt("allow") ?? "synthetic") != "tagged"
    let say = { (s: String) in FileHandle.standardError.write("eye-capture: \(s)\n".data(using: .utf8)!) }
    let mask: CGEventMask = ~CGEventMask(0)
    guard let tap = CGEvent.tapCreate(tap: .cghidEventTap, place: .headInsertEventTap, options: .defaultTap,
                                      eventsOfInterest: mask, callback: lockCallback, userInfo: nil) else {
        fail("preflight: cannot create event tap — grant Accessibility permission to the host app")
    }
    lockTap = tap
    CFRunLoopAddSource(CFRunLoopGetMain(), CFMachPortCreateRunLoopSource(nil, tap, 0), .commonModes)
    // Every check that could fail runs now, before the user sees a countdown.
    let problems = lockPreflight(tap)
    if !problems.isEmpty { fail("preflight: " + problems.joined(separator: "; ")) }
    say("preflight ok (\(pointerDevices().count) pointing devices)")
    var ended = false
    let end: (String) -> Void = { why in
        guard !ended else { return }
        ended = true
        CGEvent.tapEnable(tap: tap, enable: false)
        print(lockReport(why)) // input is free from here on
        fflush(stdout)
        if lockStyle == "quick", lockEngaged { hideQuickPill { exit(0) } } else { exit(0) }
    }
    lockEnd = end
    onTerminate { end("signal") }
    var timer: DispatchWorkItem?
    func arm(_ s: Double) {
        timer?.cancel()
        let t = DispatchWorkItem { end("timeout") }
        timer = t
        DispatchQueue.main.asyncAfter(deadline: .now() + s, execute: t)
    }
    // stdin: "extend <seconds>" pushes the end out (one lock across several calls instead of a gap and a new one);
    // "release" ends it now.
    FileHandle.standardInput.readabilityHandler = { h in
        let data = h.availableData
        guard !data.isEmpty else { h.readabilityHandler = nil; return }
        for line in (String(data: data, encoding: .utf8) ?? "").split(separator: "\n") {
            let parts = line.split(separator: " ")
            DispatchQueue.main.async {
                if parts.first == "release" { end("released") }
                else if parts.first == "extend", parts.count > 1, let s = Double(parts[1]), !ended {
                    seconds = min(s, 600)
                    if lockEngaged { arm(seconds); updateLockMessage(until: Date().addingTimeInterval(seconds)) }
                    say("extended \(seconds)s")
                }
            }
        }
    }
    let engage = {
        heldCursor = CGEvent(source: nil)?.location
        let refused = seizePointers()
        if !refused.isEmpty { end("failed: could not seize " + refused.joined(separator: "; ")); return }
        lockEngaged = true
        endInterruptedActions()
        // The overlay is only ever shown together with the lock: orange on screen = no physical input gets through.
        if lockStyle == "quick" { showQuickPill(locked: true, message: message) } else { showLockOverlay(until: Date().addingTimeInterval(seconds)) }
        // The TS side waits for this line before it drives anything.
        say("physical pointer + keyboard locked for \(seconds)s (\(lockStyle), settle \(settleMs)ms\(interrupted.isEmpty ? "" : ", ended: " + interrupted.joined(separator: ", ")); Esc ×6 = emergency release)")
        arm(seconds)
    }
    // Hands still on the trackpad (a drag, a scroll, a fling, a pinch): give them up to settleMax to finish, so
    // the lock doesn't cut an action in half. A quick lock shows its pill greyed meanwhile ("let go…").
    let settle = {
        let t0 = CACurrentMediaTime()
        var shown = false
        func poll() {
            if ended { return }
            let busy = handsBusy()
            let waited = CACurrentMediaTime() - t0
            if busy == nil || waited >= settleMax {
                settleMs = Int(waited * 1000)
                engage()
                return
            }
            if lockStyle == "quick", !shown, waited > 0.08 { shown = true; showQuickPill(locked: false, message: "let go… (\(busy!))") }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.016) { poll() }
        }
        poll()
    }
    if countdown > 0 { showLockCountdown(from: countdown, step: 0.5, then: settle) } else { settle() }
}

/// The full overlay's message layers, so `extend` can update the "locked until" time in place.
var lockMessageLayers: [(layer: CATextLayer, font: NSFont)] = []
func updateLockMessage(until: Date) {
    if lockStyle == "quick" { return }
    let f = DateFormatter(); f.dateFormat = "HH:mm:ss"
    let message = "the-eye is testing — trackpad & keyboard locked until \(f.string(from: until)) · Esc ×\(panicCount) releases"
    for (l, font) in lockMessageLayers {
        l.string = NSAttributedString(string: message, attributes: [.font: font, .foregroundColor: NSColor.black])
    }
}

/// "Just a sec…": the quick lock's whole UI. A small dark pill under the menu bar of every screen — no wash, no
/// countdown — that springs in, glows orange while input is held, and springs away the moment it's released.
/// Greyed while waiting for the user's hands to finish a drag/scroll ("let go…"). Click-through, every Space,
/// excluded from screen capture like the full overlay.
var quickPills: [(window: NSWindow, pill: CALayer, dot: CALayer, label: CATextLayer, screen: NSScreen)] = []
let quickFont = NSFont.systemFont(ofSize: 14, weight: .semibold)
let quickOrange = NSColor(srgbRed: 1, green: 0.55, blue: 0.1, alpha: 1)

func spring(_ key: String, from: Any?, to: Any, damping: CGFloat = 16, stiffness: CGFloat = 420) -> CASpringAnimation {
    let a = CASpringAnimation(keyPath: key)
    a.fromValue = from; a.toValue = to
    a.mass = 1; a.stiffness = stiffness; a.damping = damping
    a.duration = a.settlingDuration
    return a
}

func showQuickPill(locked: Bool, message: String) {
    let app = NSApplication.shared
    if quickPills.isEmpty {
        app.setActivationPolicy(.accessory)
        app.finishLaunching()
        for screen in NSScreen.screens {
            let vf = screen.visibleFrame, fr = screen.frame
            // Room for the pill, its glow, and the Esc hint under it.
            let size = CGSize(width: 520, height: 96)
            let w = NSWindow(contentRect: NSRect(x: fr.midX - size.width / 2, y: vf.maxY - size.height - 4, width: size.width, height: size.height),
                             styleMask: [.borderless], backing: .buffered, defer: false)
            w.isOpaque = false; w.backgroundColor = .clear; w.hasShadow = false
            w.ignoresMouseEvents = true
            w.level = .screenSaver
            w.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
            w.sharingType = .none
            w.animationBehavior = .none
            let v = NSView(frame: NSRect(origin: .zero, size: size)); v.wantsLayer = true
            let root = v.layer!
            let pill = CALayer()
            pill.cornerRadius = 19; pill.cornerCurve = .continuous
            pill.backgroundColor = NSColor(white: 0.08, alpha: 0.88).cgColor
            pill.borderWidth = 1.5
            pill.shadowColor = quickOrange.cgColor; pill.shadowRadius = 16; pill.shadowOffset = .zero
            let dot = CALayer(); dot.cornerRadius = 4.5; dot.bounds = CGRect(x: 0, y: 0, width: 9, height: 9)
            pill.addSublayer(dot)
            let label = CATextLayer(); label.contentsScale = screen.backingScaleFactor; label.alignmentMode = .left
            pill.addSublayer(label)
            root.addSublayer(pill)
            let hint = CATextLayer(); hint.contentsScale = screen.backingScaleFactor; hint.alignmentMode = .center
            hint.frame = CGRect(x: 0, y: 4, width: size.width, height: 20); hint.opacity = 0
            root.addSublayer(hint)
            escFeedback.append((pill, [], hint))
            w.contentView = v
            w.orderFrontRegardless()
            quickPills.append((w, pill, dot, label, screen))
            // Arrive: drop in from just above with a little overshoot.
            pill.add(spring("transform.scale", from: 0.6, to: 1, damping: 14), forKey: "in")
            pill.add(spring("opacity", from: 0, to: 1, damping: 30), forKey: "fade")
        }
    }
    let text = locked ? "\(message)  ·  Esc ×\(panicCount) releases" : message
    let tw = ceil((text as NSString).size(withAttributes: [.font: quickFont]).width)
    for q in quickPills {
        let size = q.window.frame.size
        let pw = tw + 48, ph: CGFloat = 38
        let target = CGRect(x: (size.width - pw) / 2, y: size.height - ph - 12, width: pw, height: ph)
        // Every change morphs (width, colours) on a spring instead of snapping.
        CATransaction.begin(); CATransaction.setDisableActions(true)
        let oldBounds = q.pill.bounds
        q.pill.bounds = CGRect(origin: .zero, size: target.size)
        q.pill.position = CGPoint(x: target.midX, y: target.midY)
        q.pill.shadowPath = CGPath(roundedRect: q.pill.bounds, cornerWidth: 19, cornerHeight: 19, transform: nil)
        if oldBounds.width > 0 { q.pill.add(spring("bounds", from: NSValue(rect: oldBounds), to: NSValue(rect: q.pill.bounds)), forKey: "morph") }
        let accent = locked ? quickOrange : NSColor(white: 0.6, alpha: 1)
        let oldBorder = q.pill.borderColor
        q.pill.borderColor = accent.withAlphaComponent(locked ? 0.95 : 0.5).cgColor
        q.pill.add(spring("borderColor", from: oldBorder, to: q.pill.borderColor!, damping: 30), forKey: "border")
        let oldGlow = q.pill.shadowOpacity
        q.pill.shadowOpacity = locked ? 0.55 : 0
        q.pill.add(spring("shadowOpacity", from: oldGlow, to: q.pill.shadowOpacity, damping: 30), forKey: "glow")
        q.dot.position = CGPoint(x: 20, y: ph / 2)
        q.dot.backgroundColor = accent.cgColor
        q.label.frame = CGRect(x: 34, y: (ph - 19) / 2, width: tw + 4, height: 19)
        q.label.string = NSAttributedString(string: text, attributes: [.font: quickFont, .foregroundColor: NSColor(white: 1, alpha: locked ? 0.96 : 0.7)])
        if locked {
            // The one ambient loop: the dot breathes while input is held.
            let b = CABasicAnimation(keyPath: "opacity")
            b.fromValue = 1; b.toValue = 0.55; b.duration = 0.9; b.autoreverses = true; b.repeatCount = .infinity
            b.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            q.dot.add(b, forKey: "breathe")
            q.pill.add(spring("transform.scale", from: 1.06, to: 1, damping: 12), forKey: "lockpop")
        }
        CATransaction.commit()
    }
}

/// Leave with the same spring the pill came in on (input is already free), then call `done`.
func hideQuickPill(_ done: @escaping () -> Void) {
    guard !quickPills.isEmpty else { done(); return }
    CATransaction.begin(); CATransaction.setDisableActions(true)
    for q in quickPills {
        q.pill.opacity = 0
        q.pill.add(spring("opacity", from: 1, to: 0, damping: 30), forKey: "out")
        q.pill.add(spring("transform.scale", from: 1, to: 0.7, damping: 26), forKey: "outscale")
        q.pill.transform = CATransform3DMakeScale(0.7, 0.7, 1)
    }
    CATransaction.commit()
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.28) { done() }
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
        lockMessageLayers.append((text, font))
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

// MARK: - windows: raise one to the front, put everything back afterwards

/// Private but stable since 10.x (yabai, Rectangle and AltTab rely on it): the CGWindowID behind an AX window.
@_silgen_name("_AXUIElementGetWindow") func _AXUIElementGetWindow(_ el: AXUIElement, _ id: UnsafeMutablePointer<CGWindowID>) -> AXError

enum Win {
    struct Info { let number: Int; let pid: pid_t; let owner: String; let title: String; let bounds: CGRect }
    /// Normal (layer 0) on-screen windows, front to back.
    static func windows() -> [Info] {
        let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        return list.compactMap { w in
            guard (w[kCGWindowLayer as String] as? Int) == 0,
                  let n = w[kCGWindowNumber as String] as? Int,
                  let p = (w[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
                  let b = w[kCGWindowBounds as String] as? [String: CGFloat] else { return nil }
            return Info(number: n, pid: p, owner: w[kCGWindowOwnerName as String] as? String ?? "", title: w[kCGWindowName as String] as? String ?? "",
                        bounds: CGRect(x: b["X"] ?? 0, y: b["Y"] ?? 0, width: b["Width"] ?? 0, height: b["Height"] ?? 0))
        }
    }
    static func axWindows(_ pid: pid_t) -> [AXUIElement] {
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 0.5)
        return AXI.raw(app, kAXWindowsAttribute) as? [AXUIElement] ?? []
    }
    static func id(_ w: AXUIElement) -> Int? { var n: CGWindowID = 0; return _AXUIElementGetWindow(w, &n) == .success ? Int(n) : nil }
    static func ax(_ pid: pid_t, _ num: Int) -> AXUIElement? { axWindows(pid).first { id($0) == num } }
    static func frontPid() -> pid_t {
        guard let v = AXI.raw(AXI.system, kAXFocusedApplicationAttribute), AXI.isElement(v) else { return 0 }
        return AXI.pid(v as! AXUIElement)
    }
    /// AXRaise alone stops just under the active app's key window: making the app frontmost too puts it on top.
    static func raise(_ pid: pid_t, _ w: AXUIElement) {
        AXUIElementPerformAction(w, kAXRaiseAction as CFString)
        AXUIElementSetAttributeValue(AXUIElementCreateApplication(pid), kAXFrontmostAttribute as CFString, kCFBooleanTrue)
    }
    static func frameOf(_ w: AXUIElement) -> CGRect? { AXI.frame(AXI.many(w, [kAXPositionAttribute, kAXSizeAttribute])) }

    /// Bring one window of `pid` to the very front (default: its main window, else the largest; `title` substring
    /// or window `number` picks another). Waits until the window server shows it on top. Returns everything
    /// `restore` needs to put the screen back as it was: the z-order before, the app that was frontmost, whether
    /// the window was minimized, and its frame.
    static func raiseOp(_ c: [String: Any]) -> [String: Any] {
        guard AXIsProcessTrusted() else { return ["ok": false, "error": "Accessibility permission missing for the host app"] }
        guard let pid = (c["pid"] as? NSNumber)?.int32Value else { return ["ok": false, "error": "raise needs pid"] }
        let before = windows()
        let frontApp = frontPid()
        let all = axWindows(pid)
        let wantTitle = (c["title"] as? String)?.lowercased()
        let wantNum = (c["number"] as? NSNumber)?.intValue
        let area = { (w: AXUIElement) -> CGFloat in let f = frameOf(w) ?? .zero; return f.width * f.height }
        var candidates = all.filter { AXI.text(AXI.raw($0, kAXRoleAttribute)) == "AXWindow" }
        if candidates.isEmpty { candidates = all }
        var win: AXUIElement?
        if let n = wantNum { win = candidates.first { id($0) == n } }
        else if let t = wantTitle { win = candidates.first { (AXI.text(AXI.raw($0, kAXTitleAttribute)) ?? "").lowercased().contains(t) } }
        else {
            win = candidates.first { AXI.bool(AXI.raw($0, kAXMainAttribute)) == true && AXI.bool(AXI.raw($0, kAXMinimizedAttribute)) != true }
                ?? candidates.filter { AXI.bool(AXI.raw($0, kAXMinimizedAttribute)) != true }.max { area($0) < area($1) }
                ?? candidates.first
        }
        guard let w = win, let num = id(w) else {
            let titles = candidates.compactMap { AXI.text(AXI.raw($0, kAXTitleAttribute)) }.map { "\"\($0)\"" }.joined(separator: ", ")
            return ["ok": false, "error": candidates.isEmpty ? "pid \(pid) has no windows" : "no window of pid \(pid) matches (windows: \(titles))"]
        }
        let minimized = AXI.bool(AXI.raw(w, kAXMinimizedAttribute)) == true
        // locate: where that window is, without touching anything (the rect to record or look at).
        if (c["locate"] as? Bool) == true {
            let f = frameOf(w) ?? before.first { $0.number == num }?.bounds ?? .zero
            var ids = [CGDirectDisplayID](repeating: 0, count: 8), n: UInt32 = 0
            CGGetDisplaysWithPoint(CGPoint(x: f.midX, y: f.midY), 8, &ids, &n)
            let disp = n > 0 ? ids[0] : CGMainDisplayID(), b = CGDisplayBounds(disp)
            return ["ok": true, "op": "raise", "pid": Int(pid), "number": num, "title": AXI.text(AXI.raw(w, kAXTitleAttribute)) ?? "",
                    "frame": [f.minX, f.minY, f.width, f.height], "minimized": minimized,
                    "on_top": !minimized && before.first?.number == num, "on_screen": before.contains { $0.number == num },
                    "display": Int(disp), "display_bounds": [b.minX, b.minY, b.width, b.height]]
        }
        let wasFront = !minimized && frontApp == pid && before.first?.number == num
        let t0 = CACurrentMediaTime()
        if !wasFront {
            if minimized { AXUIElementSetAttributeValue(w, kAXMinimizedAttribute as CFString, kCFBooleanFalse) }
            raise(pid, w)
        }
        // Raised = first in the window server's front-to-back list. Usually ~50ms; un-minimizing animates longer.
        var onTop = wasFront
        while !onTop && CACurrentMediaTime() - t0 < (minimized ? 1.5 : 0.8) {
            usleep(10000)
            onTop = windows().first?.number == num
            if !onTop, CACurrentMediaTime() - t0 > 0.3 { raise(pid, w) } // focus stolen back once: insist
        }
        let f = frameOf(w) ?? before.first { $0.number == num }?.bounds ?? .zero
        var o: [String: Any] = [
            "ok": true, "op": "raise", "pid": Int(pid), "number": num, "title": AXI.text(AXI.raw(w, kAXTitleAttribute)) ?? "",
            "frame": [f.minX, f.minY, f.width, f.height], "was_minimized": minimized, "already_front": wasFront,
            "front_pid": Int(frontApp), "before": before.map(\.number), "on_top": onTop,
            "raise_ms": Int((CACurrentMediaTime() - t0) * 1000),
        ]
        // The display the window is mostly on, and its origin: snapshot/record rects are display-local.
        var ids = [CGDirectDisplayID](repeating: 0, count: 8), n: UInt32 = 0
        CGGetDisplaysWithPoint(CGPoint(x: f.midX, y: f.midY), 8, &ids, &n)
        let disp = n > 0 ? ids[0] : CGMainDisplayID(), origin = CGDisplayBounds(disp).origin
        o["display"] = Int(disp); o["display_origin"] = [origin.x, origin.y]
        if !onTop { o["warning"] = "the window is not the topmost one after \(o["raise_ms"]!)ms (another app keeps taking focus, or it lives on another Space)" }
        return o
    }

    /// Undo `raiseOp`: frame back, re-minimize, focus back to the app that had it, and re-raise the windows that
    /// were above ours from the back forward, so the z-order ends where it started.
    static func restoreOp(_ c: [String: Any]) -> [String: Any] {
        guard let pid = (c["pid"] as? NSNumber)?.int32Value, let num = (c["number"] as? NSNumber)?.intValue,
              let before = (c["before"] as? [NSNumber])?.map(\.intValue) else { return ["ok": false, "error": "restore needs the raise result"] }
        if (c["already_front"] as? Bool) == true { return ["ok": true, "op": "restore", "restored": "nothing to do (it was already in front)"] }
        var did: [String] = []
        let target = ax(pid, num)
        // Something in the check moved or resized the window: put it back where it was.
        if let w = target, let f = (c["frame"] as? [NSNumber])?.map({ CGFloat($0.doubleValue) }), f.count == 4,
           let cur = frameOf(w), abs(cur.minX - f[0]) + abs(cur.minY - f[1]) + abs(cur.width - f[2]) + abs(cur.height - f[3]) > 1 {
            var pos = CGPoint(x: f[0], y: f[1]), size = CGSize(width: f[2], height: f[3])
            if let v = AXValueCreate(.cgSize, &size) { AXUIElementSetAttributeValue(w, kAXSizeAttribute as CFString, v) }
            if let v = AXValueCreate(.cgPoint, &pos) { AXUIElementSetAttributeValue(w, kAXPositionAttribute as CFString, v) }
            did.append("frame")
        }
        if (c["was_minimized"] as? Bool) == true, let w = target {
            AXUIElementSetAttributeValue(w, kAXMinimizedAttribute as CFString, kCFBooleanTrue)
            did.append("re-minimized")
        }
        let now0 = windows()
        let pidOf = Dictionary(now0.map { ($0.number, $0.pid) }, uniquingKeysWith: { a, _ in a })
        if let fp = (c["front_pid"] as? NSNumber)?.int32Value, fp != 0, fp != pid {
            AXUIElementSetAttributeValue(AXUIElementCreateApplication(fp), kAXFrontmostAttribute as CFString, kCFBooleanTrue)
            // Activation is asynchronous. AXRaise puts an inactive app's window just under the ACTIVE app's windows,
            // so raising before the switch lands would slot the windows under our (still active) app instead.
            let tf = CACurrentMediaTime()
            while frontPid() != fp && CACurrentMediaTime() - tf < 0.3 { usleep(5000) }
            did.append("focus → pid \(fp)")
        }
        // Windows that were above ours, raised back to front (the frontmost last). Skips any that closed since.
        let above = Array(before.prefix { $0 != num })
        var cache: [pid_t: [AXUIElement]] = [:]
        func reraise() {
            for n in above.reversed() {
                guard let p = pidOf[n] else { continue }
                let wins = cache[p] ?? axWindows(p); cache[p] = wins
                if let aw = wins.first(where: { id($0) == n }) { AXUIElementPerformAction(aw, kAXRaiseAction as CFString) }
            }
        }
        reraise()
        if !above.isEmpty { did.append("re-raised \(above.count) window\(above.count == 1 ? "" : "s") above it") }
        // Verify: the windows that still exist are back in their old relative order. One more pass if not.
        var ok = false, retried = false
        let t0 = CACurrentMediaTime()
        repeat {
            let now = windows().map(\.number)
            let a = now.filter { before.contains($0) }, b = before.filter { now.contains($0) }
            ok = (c["was_minimized"] as? Bool) == true ? a == b.filter { $0 != num } : a == b
            if !ok {
                if !retried, CACurrentMediaTime() - t0 > 0.15 { retried = true; reraise(); did.append("second pass") }
                usleep(15000)
            }
        } while !ok && CACurrentMediaTime() - t0 < 0.6
        return ["ok": true, "op": "restore", "restored": did.joined(separator: ", "), "order_restored": ok]
    }
}


// MARK: - input actor
//
// `input` reads one JSON command per stdin line and answers one JSON line when it has finished:
//   {"op":"move","x":..,"y":..,"ms":300}         glide from the current pointer (ms 0 = jump)
//   {"op":"click","x"?,"y"?,"button":"left|right","count":1,"hold_ms":60}
//   {"op":"down"|"up","button":"left"}             press / release (drag = down, move, up)
//   {"op":"scroll","dy":-5,"dx":0,"events":30,"interval_ms":8,"phased":true}
//                                                   phased = trackpad-style began/changed/ended; "momentum":true
//                                                   adds the coasting tail after the fingers lift ("decay" 0.94)
//   {"op":"pinch","scale":1.5,"ms":300}             two-finger pinch (scale > 1 spreads / zooms in)
//   {"op":"rotate","degrees":45,"ms":300}           two-finger rotation (+ = clockwise)
//   {"op":"smart_zoom"}                              two-finger double-tap
//   {"op":"swipe","direction":"left|right|up|down"}  navigation swipe (back / forward)
//   {"op":"pos"}                                    current pointer position
//   {"op":"owner","x"?,"y"?}                         topmost window under a point {pid, owner, layer, number}
//   {"op":"inspect","x"?,"y"?,"brief"?}              AX element under a point (everything it exposes) + its window
//   {"op":"tree","rect"?:[x,y,w,h],"display"?,"x"?,"y"?,"process"?,"mode":"basic|full","depth"?,"max_nodes"?,"limit"?,"clip"?,"out"?}
//                                                   AX element tree (with frames) of the windows in a display-local rect,
//                                                   or of the single window under a point; full JSON to `out`
// click/down and the gestures accept "require_pid": the press is refused unless that pid owns the topmost window there.
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
        // AX hit-test first: it follows real click routing. CG's topmost window is often a click-through one (the Dock
        // keeps a full-screen layer-20 window over every normal app), which would refuse every press on a normal window.
        if AXIsProcessTrusted(), let el = AXI.hit(p) {
            let got = Int(AXI.pid(el))
            if got == want { return nil }
            let name = NSRunningApplication(processIdentifier: pid_t(got))?.localizedName ?? "pid \(got)"
            return "REFUSED press at \(Int(p.x)),\(Int(p.y)): the element there belongs to \(name) (pid \(got)), not pid \(want)"
        }
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
            // Fingers lifted mid-flick: the trackpad keeps going on its own with decaying momentum events
            // (momentum phase 1 begin, 2 continue, 3 end; scroll phase 0), which is what flings, rubber-banding
            // and page swipes react to.
            if phased, (c["momentum"] as? Bool) == true {
                func mom(_ phase: Int64, _ y: Int32, _ x: Int32) {
                    guard let e = CGEvent(scrollWheelEvent2Source: src, units: .pixel, wheelCount: 2, wheel1: y, wheel2: x, wheel3: 0) else { return }
                    e.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
                    e.setIntegerValueField(.scrollWheelEventMomentumPhase, value: phase)
                    e.location = pointer()
                    send(e)
                }
                var vy = Double(dy), vx = Double(dx), first = true
                let decay = num("decay", 0.94)
                while abs(vy) >= 1 || abs(vx) >= 1 {
                    vy *= decay; vx *= decay
                    mom(first ? 1 : 2, Int32(vy.rounded()), Int32(vx.rounded())); first = false
                    usleep(8333)
                }
                mom(3, 0, 0)
            }
        case "pinch", "rotate", "smart_zoom", "swipe":
            // Trackpad gestures. Not in any public header: an NSEventTypeGesture (29) CGEvent whose CGS field 110
            // carries the IOHID event type (8 zoom, 5 rotation, 22 zoom toggle, 16 navigation swipe), 113/114 the
            // magnification / rotation delta, 115 the swipe direction, 132 the IOHID phase (1 began, 2 changed,
            // 4 ended). Field map from Calf Trail's TouchSynthesis via Mac Mouse Fix's TouchSimulator.
            // They have to enter at the session tap: posted at the HID tap AppKit never sees them.
            // Gestures route to the window under the cursor, and the window server takes a few ms to notice that
            // a pointer which just jumped in is now over a new window: the first gesture after a jump is dropped.
            // Re-assert the position and let it settle first.
            let at = c["x"] != nil || c["y"] != nil ? CGPoint(x: num("x", pointer().x), y: num("y", pointer().y)) : pointer()
            moveEvent(at); usleep(40000)
            if let why = pressAllowed(c, at: pointer()) { reply(["ok": false, "error": why]); continue }
            func gesture(_ type: Int64, _ phase: Int64, _ set: (CGEvent) -> Void = { _ in }) {
                guard let e = CGEvent(source: src) else { return }
                e.type = CGEventType(rawValue: 29)!
                e.location = pointer()
                e.setIntegerValueField(CGEventField(rawValue: 110)!, value: type)
                e.setIntegerValueField(CGEventField(rawValue: 132)!, value: phase)
                set(e)
                e.setIntegerValueField(.eventSourceUserData, value: eyeTag)
                e.post(tap: .cgSessionEventTap)
            }
            let frame: useconds_t = 8333
            let steps = max(2, Int(num("ms", 300) / 8.333))
            // Smoothstep weights: fingers accelerate in and settle out, like a hand does, instead of a constant rate.
            func weights() -> [Double] {
                let s = (0...steps).map { i -> Double in let t = Double(i) / Double(steps); return t * t * (3 - 2 * t) }
                return (1...steps).map { s[$0] - s[$0 - 1] }
            }
            switch op {
            case "pinch":
                // scale 2 = spread to twice the size, 0.5 = pinch to half. NSEvent.magnification is a per-event
                // delta that apps accumulate as product(1 + m) — split ln(scale) so the product lands exactly.
                let scale = num("scale", 1.5)
                guard scale > 0 else { reply(["ok": false, "error": "pinch: scale must be > 0"]); continue }
                gesture(8, 1) { $0.setDoubleValueField(CGEventField(rawValue: 113)!, value: 0) }
                for w in weights() {
                    usleep(frame)
                    let m = exp(log(scale) * w) - 1
                    gesture(8, 2) { $0.setDoubleValueField(CGEventField(rawValue: 113)!, value: m) }
                }
                usleep(frame)
                gesture(8, 4) { $0.setDoubleValueField(CGEventField(rawValue: 113)!, value: 0) }
            case "rotate":
                // degrees > 0 turns clockwise on screen. AppKit's NSEvent.rotation is the opposite (counter-clockwise
                // positive), so the sign flips on the way in.
                let deg = num("degrees", 45)
                gesture(5, 1)
                for w in weights() {
                    usleep(frame)
                    gesture(5, 2) { $0.setDoubleValueField(CGEventField(rawValue: 114)!, value: -deg * w) }
                }
                usleep(frame)
                gesture(5, 4)
            case "smart_zoom":
                gesture(22, 0) // two-finger double-tap
            default:
                // Navigation swipe (back/forward, NSEvent.swipe): direction left/right/up/down.
                let dirs: [String: Int64] = ["up": 1, "down": 2, "left": 4, "right": 8]
                guard let d = dirs[(c["direction"] as? String) ?? "left"] else { reply(["ok": false, "error": "swipe: direction must be left|right|up|down"]); continue }
                gesture(16, 1) { $0.setIntegerValueField(CGEventField(rawValue: 115)!, value: d) }
                usleep(frame)
                gesture(16, 4) { $0.setIntegerValueField(CGEventField(rawValue: 115)!, value: 0) }
            }
        case "press", "force_click":
            // A Force Touch press: mouse down, a pressure curve, mouse up. `force` is one continuous axis of keyframes:
            // 0…1 is stage 1 (an ordinary click, NSEvent.pressure 0…1), crossing 1 is the force click (stage 2),
            // 1…2 is pressure inside stage 2. Keyframes are spread evenly over `ms`, eased between.
            // Pressure events are NSEventTypeGesture CGEvents with IOHID type 32 (kIOHIDEventTypeForce). The field
            // layout below is read off a real trackpad's events (listen-only tap): 132 phase (1 began, 2 changed,
            // 4 ended), 143 stage, 144 pressure behavior (5 = deep click, the default), pressure mirrored as a double
            // in 119/139/148 and as float32 bits in 123/165, stageTransition the same way in 113/114/116/118/147
            // and 115/117/164. A real press starts the pressure gesture just before mouse down and ends it just before
            // mouse up, like this one.
            if c["x"] != nil || c["y"] != nil {
                let p0 = pointer()
                moveEvent(CGPoint(x: num("x", p0.x), y: num("y", p0.y))); usleep(40000)
            }
            if let why = pressAllowed(c, at: pointer()) { reply(["ok": false, "error": why]); continue }
            let curve = ((c["force"] as? [NSNumber])?.map { max(0, min(2, $0.doubleValue)) })
                ?? (op == "force_click" ? [0, 0.9, 1.5, 1.5, 0.9, 0] : [0, 0.5, 0])
            guard curve.count >= 2 else { reply(["ok": false, "error": "press: force needs at least 2 keyframes, e.g. [0, 0.5, 0]"]); continue }
            func setF(_ e: CGEvent, _ dbl: [UInt32], _ bits: [UInt32], _ v: Double) {
                for k in dbl { e.setDoubleValueField(CGEventField(rawValue: k)!, value: v) }
                for k in bits { e.setIntegerValueField(CGEventField(rawValue: k)!, value: Int64(Float(v).bitPattern)) }
            }
            var maxStage = 1
            func force(_ phase: Int64, _ f: Double) {
                guard let e = CGEvent(source: src) else { return }
                e.type = CGEventType(rawValue: 29)!
                e.location = pointer()
                let stage = phase == 4 ? 0 : f >= 1 ? 2 : 1
                maxStage = max(maxStage, stage)
                let pressure = phase == 4 ? 0 : stage == 2 ? min(1, f - 1) : f
                // Positive while closing in on the force click; negative while easing back out of it.
                let transition = stage == 1 ? max(0, (f - 0.7) / 0.3) : stage == 2 ? -max(0, 1 - (f - 1) / 0.25) : 0
                e.setIntegerValueField(CGEventField(rawValue: 110)!, value: 32)
                e.setIntegerValueField(CGEventField(rawValue: 132)!, value: phase)
                e.setIntegerValueField(CGEventField(rawValue: 143)!, value: Int64(stage))
                e.setIntegerValueField(CGEventField(rawValue: 144)!, value: Int64(num("behavior", 5)))
                setF(e, [119, 139, 148], [123, 165], pressure)
                setF(e, [113, 114, 116, 118, 147], [115, 117, 164], transition)
                e.setIntegerValueField(.eventSourceUserData, value: eyeTag)
                e.post(tap: .cgSessionEventTap)
            }
            let frame: useconds_t = 8333
            let steps = max(curve.count, Int(num("ms", op == "force_click" ? 700 : 400) / 8.333))
            func at(_ i: Int) -> Double {
                let x = Double(i) / Double(steps) * Double(curve.count - 1)
                let k = min(curve.count - 2, Int(x)), t = x - Double(k), s = t * t * (3 - 2 * t)
                return curve[k] + (curve[k + 1] - curve[k]) * s
            }
            let p = pointer()
            force(1, 0)
            let dn = CGEvent(mouseEventSource: src, mouseType: .leftMouseDown, mouseCursorPosition: p, mouseButton: .left)
            dn?.setIntegerValueField(.mouseEventClickState, value: 1); send(dn)
            for i in 1...steps { usleep(frame); force(2, at(i)) }
            usleep(frame)
            force(4, 0)
            let upE = CGEvent(mouseEventSource: src, mouseType: .leftMouseUp, mouseCursorPosition: p, mouseButton: .left)
            upE?.setIntegerValueField(.mouseEventClickState, value: 1); send(upE)
            reply(["ok": true, "op": op, "x": p.x, "y": p.y, "ms": Int(Date().timeIntervalSince(t0) * 1000),
                   "peak_force": curve.max() ?? 0, "force_clicked": maxStage == 2]); continue
        case "pos": break
        case "raise": reply(Win.raiseOp(c)); continue
        case "restore": reply(Win.restoreOp(c)); continue
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

// MARK: - watch: UI events as lines, so an agent can wait on the screen instead of polling it

/// Element-equality wrapper (AX refs to the same element are CFEqual, not pointer-equal).
struct AXKey: Hashable {
    let el: AXUIElement
    static func == (a: AXKey, b: AXKey) -> Bool { CFEqual(a.el, b.el) }
    func hash(into h: inout Hasher) { h.combine(CFHash(el)) }
}

final class Watch {
    struct Win { let pid: pid_t; var title: String; let kind: String }
    /// System agents that put up the dialogs an agent most often waits on (permission prompts, banners,
    /// Gatekeeper). Observed by default alongside every regular app.
    static let systemUI: Set<String> = ["com.apple.notificationcenterui", "com.apple.UserNotificationCenter",
                                        "com.apple.CoreServicesUIAgent", "com.apple.coreservices.uiagent",
                                        "com.apple.SecurityAgent", "com.apple.accessibility.universalAccessAuthWarn"]

    let asJSON = argv.contains("--json")
    let values = argv.contains("--values")
    let untils: [String] = argv.indices.filter { argv[$0] == "--until" && $0 + 1 < argv.count }.map { argv[$0 + 1].lowercased() }
    let apps: [String] = argv.indices.filter { argv[$0] == "--app" && $0 + 1 < argv.count }.map { argv[$0 + 1].lowercased() }
    var observers: [pid_t: AXObserver] = [:]
    var names: [pid_t: String] = [:]
    var windows: [AXKey: Win] = [:]
    var lastValue: [AXKey: (at: Double, text: String)] = [:]
    var pendingValue: Set<AXKey> = []
    var lastActivate: (pid: pid_t, at: Double) = (0, 0)
    var lastLine = (text: "", at: 0.0)
    let clock = DateFormatter()
    let debugRaw = ProcessInfo.processInfo.environment["EYE_WATCH_RAW"] != nil

    init() { clock.dateFormat = "HH:mm:ss" }
    func now() -> Double { Date().timeIntervalSinceReferenceDate }

    func wanted(_ app: NSRunningApplication) -> Bool {
        let pid = app.processIdentifier
        guard pid != getpid(), app.localizedName != "eye-capture" else { return false }
        if apps.isEmpty { return app.activationPolicy == .regular || Watch.systemUI.contains(app.bundleIdentifier ?? "") }
        let name = (app.localizedName ?? "").lowercased(), bid = (app.bundleIdentifier ?? "").lowercased()
        return apps.contains { $0 == String(pid) || $0 == bid || name == $0 || name.hasPrefix($0) }
    }

    // MARK: output

    func emit(_ event: String, _ pid: pid_t, _ fields: [String: Any] = [:], initial: Bool = false) {
        let app = names[pid] ?? NSRunningApplication(processIdentifier: pid)?.localizedName ?? "pid \(pid)"
        var text = "\(event) \(app)"
        if let k = fields["kind"] as? String, !event.hasPrefix(k) { text += " \(k)" }
        if let t = fields["title"] as? String, !t.isEmpty { text += " \"\(t)\"" }
        if let old = fields["from"] as? String { text = "\(event) \(app) \"\(old)\" → \"\(fields["title"] as? String ?? "")\"" }
        if let v = fields["value"] as? String { text += " = \"\(v)\"" }
        if let ts = fields["texts"] as? [String], !ts.isEmpty { text += " — " + ts.map { "\"\($0)\"" }.joined(separator: " ") }
        if let bs = fields["buttons"] as? [String], !bs.isEmpty { text += " [" + bs.joined(separator: " | ") + "]" }
        let matched = !untils.isEmpty && untils.contains { text.lowercased().contains($0) }
        if initial && !matched { return }              // existing state is only reported when it already satisfies --until
        let t = now()
        if text == lastLine.text && t - lastLine.at < 0.4 { return }   // AX double-fires some notifications
        lastLine = (text, t)
        if asJSON {
            var o = fields; o["event"] = initial ? "already-" + event : event; o["app"] = app; o["pid"] = pid
            o["t"] = Date().timeIntervalSince1970; if matched { o["matched"] = true }
            print(json(o))
        } else {
            print("\(clock.string(from: Date())) \(initial ? "already " : "")\(text)")
        }
        if matched { exit(0) }
    }

    // MARK: describing what appeared

    static func role(_ el: AXUIElement) -> (role: String, subrole: String) {
        let v = AXI.many(el, [kAXRoleAttribute, kAXSubroleAttribute])
        return (v[kAXRoleAttribute] as? String ?? "", v[kAXSubroleAttribute] as? String ?? "")
    }
    static func title(_ el: AXUIElement) -> String { AXI.text(AXI.raw(el, kAXTitleAttribute), max: 120) ?? "" }

    /// What a person would read in a window: its texts and its buttons. Bounded walk; dialogs are small.
    static func contents(_ root: AXUIElement) -> (texts: [String], buttons: [String]) {
        var texts: [String] = [], buttons: [String] = [], queue: [(AXUIElement, Int)] = [(root, 0)], seen = 0
        while !queue.isEmpty, seen < 120, texts.count < 4 || buttons.count < 6 {
            let (el, depth) = queue.removeFirst(); seen += 1
            let v = AXI.many(el, [kAXRoleAttribute, kAXTitleAttribute, kAXValueAttribute, kAXDescriptionAttribute, kAXChildrenAttribute])
            let r = v[kAXRoleAttribute] as? String ?? ""
            let label = [kAXValueAttribute, kAXTitleAttribute, kAXDescriptionAttribute].lazy
                .compactMap { AXI.text(v[$0], max: 100) }.first { !$0.isEmpty }
            if r == "AXStaticText", let l = label, texts.count < 4, !texts.contains(l) { texts.append(l) }
            if r == "AXButton", let l = (AXI.text(v[kAXTitleAttribute], max: 40) ?? label), !l.isEmpty, buttons.count < 6, !buttons.contains(l) { buttons.append(l) }
            if ["AXSearchField", "AXTextField", "AXComboBox", "AXTextArea", "AXWebArea"].contains(r) { continue }   // their insides aren't what the window says
            if depth < 8, let kids = v[kAXChildrenAttribute] as? [AXUIElement] { queue += kids.prefix(40).map { ($0, depth + 1) } }
        }
        return (texts, buttons)
    }

    /// Window or sheet → fields. Plain document windows report just their title; anything modal, floating
    /// or untitled (dialogs, alerts, sheets, banners, panels) also reports what it says and its buttons.
    func describe(_ el: AXUIElement, _ pid: pid_t) -> [String: Any] {
        let (r, s) = Watch.role(el)
        let kind = r == "AXSheet" ? "sheet" : s == "AXDialog" || s == "AXSystemDialog" ? "dialog"
            : s == "AXFloatingWindow" || s == "AXSystemFloatingWindow" ? "panel" : "window"
        let t = Watch.title(el)
        var o: [String: Any] = ["title": t]
        if kind != "window" { o["kind"] = kind }
        if kind != "window" || t.isEmpty || Watch.systemUI.contains(NSRunningApplication(processIdentifier: pid)?.bundleIdentifier ?? "") {
            let c = Watch.contents(el)
            if !c.texts.isEmpty { o["texts"] = c.texts.filter { $0 != t } }
            if !c.buttons.isEmpty { o["buttons"] = c.buttons }
        }
        return o
    }

    func track(_ el: AXUIElement, _ pid: pid_t, _ fields: [String: Any]) {
        windows[AXKey(el: el)] = Win(pid: pid, title: fields["title"] as? String ?? "", kind: fields["kind"] as? String ?? "window")
        if let obs = observers[pid] { AXObserverAddNotification(obs, el, kAXUIElementDestroyedNotification as CFString, nil) }
    }

    // MARK: AX callbacks

    func handle(_ el: AXUIElement, _ note: String, _ info: CFDictionary?) {
        let pid = AXI.pid(el)
        if debugRaw { FileHandle.standardError.write("raw \(note) \(AXI.summary(el))\(info.map { " info=\(($0 as NSDictionary).description.replacingOccurrences(of: "\n", with: " "))" } ?? "")\n".data(using: .utf8)!) }
        switch note {
        case kAXWindowCreatedNotification, kAXSheetCreatedNotification, kAXDrawerCreatedNotification:
            // Content is often filled in a beat after the window exists: describe it once it has settled.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [self] in
                guard windows[AXKey(el: el)] == nil else { return }
                let f = describe(el, pid)
                track(el, pid, f)
                emit(note == kAXSheetCreatedNotification ? "sheet-opened" : "window-opened", pid, f)
            }
        case kAXUIElementDestroyedNotification:
            guard let w = windows.removeValue(forKey: AXKey(el: el)) else { return }
            var f: [String: Any] = ["title": w.title]; if w.kind != "window" { f["kind"] = w.kind }
            emit(w.kind == "sheet" ? "sheet-closed" : "window-closed", w.pid, f)
        case kAXTitleChangedNotification:
            let k = AXKey(el: el)
            guard var w = windows[k] else { return }
            let t = Watch.title(el)
            guard t != w.title else { return }
            emit("title-changed", pid, ["from": w.title, "title": t])
            w.title = t; windows[k] = w
        case kAXFocusedWindowChangedNotification:
            if lastActivate.pid == pid && now() - lastActivate.at < 0.6 { return }   // already said by app-focused
            if windows[AXKey(el: el)] == nil && Watch.role(el).role == "AXWindow" { return }   // brand new: window-opened says it
            let t = Watch.title(el)
            if !t.isEmpty { emit("window-focused", pid, ["title": t]) }   // untitled = a sheet or a window mid-close: noise
        case kAXWindowMiniaturizedNotification:
            emit("window-minimized", pid, ["title": Watch.title(el)])
        case kAXAnnouncementRequestedNotification:
            // Apps send either a String or an NSAttributedString (Calculator: "Result, 46" with a priority attribute).
            let raw = (info as? [String: Any])?[kAXAnnouncementKey as String]
            let text = ((raw as? NSAttributedString)?.string ?? raw as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty { emit("announced", pid, ["title": text]) }
        case kAXValueChangedNotification:
            valueChanged(el, pid)
        default: break
        }
    }

    /// Value changes are leading-edge + trailing throttled per element (≤1/s), so a progress bar reports its
    /// first move, then once a second, and always its final value.
    func valueChanged(_ el: AXUIElement, _ pid: pid_t, trailing: Bool = false) {
        let k = AXKey(el: el)
        if trailing { pendingValue.remove(k) } else if pendingValue.contains(k) { return }
        let (r, _) = Watch.role(el)
        guard ["AXStaticText", "AXProgressIndicator", "AXBusyIndicator", "AXLevelIndicator", "AXValueIndicator"].contains(r) else { return }
        let v = AXI.raw(el, kAXValueAttribute)
        let text = AXI.text(v, max: 100) ?? ""
        let shown = r == "AXProgressIndicator" ? (v as? NSNumber).map { n -> String in
            let mx = (AXI.raw(el, kAXMaxValueAttribute) as? NSNumber)?.doubleValue ?? 1
            return "\(Int((n.doubleValue / (mx > 0 ? mx : 1) * 100).rounded()))%"
        } ?? text : text
        guard !shown.isEmpty else { return }
        // A window's own title text repeats title-changed; a window not announced yet (an alert being filled in)
        // reports its texts with window-opened / sheet-opened instead.
        let top = AXI.raw(el, kAXTopLevelUIElementAttribute).flatMap { AXI.isElement($0) ? ($0 as! AXUIElement) : nil }
            ?? AXI.raw(el, kAXWindowAttribute).flatMap { AXI.isElement($0) ? ($0 as! AXUIElement) : nil }
        if let top {
            if windows[AXKey(el: top)] == nil { return }   // not announced yet: window-opened/sheet-opened will carry its texts
            if Watch.title(top) == shown { return }         // the window's own title text: title-changed says it
        }
        let t = now()
        if let last = lastValue[k] {
            if last.text == shown { return }
            if t - last.at < 1 {
                pendingValue.insert(k)
                DispatchQueue.main.asyncAfter(deadline: .now() + (1 - (t - last.at))) { [self] in valueChanged(el, pid, trailing: true) }
                return
            }
        }
        lastValue[k] = (t, shown)
        emit("value-changed", pid, ["kind": String(r.dropFirst(2)), "value": shown])
    }

    // MARK: wiring

    /// `initial`: windows already up at watch start (only reported if they satisfy --until). `fresh`: the app
    /// just launched, so every window it has is new and reports as opened. Returns false while the app isn't
    /// answering AX yet (an observer attached before then never receives anything).
    @discardableResult
    func observe(_ app: NSRunningApplication, initial: Bool, fresh: Bool = false) -> Bool {
        let pid = app.processIdentifier
        guard observers[pid] == nil else { return true }
        guard wanted(app) else { return true }
        let probe = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(probe, 0.3)
        var wv: CFTypeRef?
        guard AXUIElementCopyAttributeValue(probe, kAXWindowsAttribute as CFString, &wv) == .success else { return false }
        var obs: AXObserver?
        let cb: AXObserverCallbackWithInfo = { _, el, note, info, _ in watcher.handle(el, note as String, info) }
        guard AXObserverCreateWithInfoCallback(pid, cb, &obs) == .success, let obs else { return false }
        let root = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(root, 0.3)
        var notes = [kAXWindowCreatedNotification, kAXSheetCreatedNotification, kAXDrawerCreatedNotification, kAXTitleChangedNotification,
                     kAXFocusedWindowChangedNotification, kAXWindowMiniaturizedNotification, kAXAnnouncementRequestedNotification]
        if values { notes.append(kAXValueChangedNotification) }
        var ok = 0
        for n in notes where AXObserverAddNotification(obs, root, n as CFString, nil) == .success { ok += 1 }
        guard ok > 0 else { return false }   // not answering AX (yet)
        observers[pid] = obs
        names[pid] = app.localizedName ?? "pid \(pid)"
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(obs), .defaultMode)
        // Windows (and their sheets) that already exist: remember them so closes and title changes report,
        // and if one already says what --until waits for, the wait is over before it started.
        for w in (AXI.raw(root, kAXWindowsAttribute) as? [AXUIElement]) ?? [] {
            let f = describe(w, pid)
            track(w, pid, f)
            if initial || fresh { emit(fresh ? "window-opened" : "window", pid, f, initial: initial) }
            for s in (AXI.raw(w, kAXChildrenAttribute) as? [AXUIElement]) ?? [] where Watch.role(s).role == "AXSheet" {
                let sf = describe(s, pid); track(s, pid, sf)
                if initial || fresh { emit(fresh ? "sheet-opened" : "sheet", pid, sf, initial: initial) }
            }
        }
        return true
    }

    func forget(_ pid: pid_t) {
        if let obs = observers.removeValue(forKey: pid) {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(obs), .defaultMode)
        }
        windows = windows.filter { $0.value.pid != pid }
    }

    func start() {
        let ws = NSWorkspace.shared, nc = ws.notificationCenter
        func app(_ n: Notification) -> NSRunningApplication? { n.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication }
        nc.addObserver(forName: NSWorkspace.didLaunchApplicationNotification, object: nil, queue: .main) { [self] n in
            guard let a = app(n), wanted(a) else { return }
            names[a.processIdentifier] = a.localizedName
            emit("app-launched", a.processIdentifier)
            // AX isn't answering the instant a process launches: attach once it is (checked 4×/s, up to 10 s).
            func attach(_ tries: Int) {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [self] in
                    if a.isTerminated || observe(a, initial: false, fresh: true) || tries <= 0 { return }
                    attach(tries - 1)
                }
            }
            attach(40)
        }
        nc.addObserver(forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main) { [self] n in
            guard let a = app(n), wanted(a) || observers[a.processIdentifier] != nil else { return }
            emit("app-quit", a.processIdentifier)
            forget(a.processIdentifier)
        }
        nc.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [self] n in
            guard let a = app(n), wanted(a) else { return }
            let pid = a.processIdentifier
            lastActivate = (pid, now())
            let front = AXI.raw(AXUIElementCreateApplication(pid), kAXFocusedWindowAttribute).map { Watch.title($0 as! AXUIElement) } ?? ""
            emit("app-focused", pid, ["title": front])
        }
        for a in ws.runningApplications { observe(a, initial: true) }
        let list = observers.keys.compactMap { names[$0] }.sorted()
        let what = apps.isEmpty ? "\(list.count) apps + system dialogs" : list.isEmpty ? "nothing running yet (\(apps.joined(separator: ", ")))" : list.joined(separator: ", ")
        let until = untils.isEmpty ? "" : " until " + untils.map { "\"\($0)\"" }.joined(separator: " or ")
        if asJSON { print(json(["event": "ready", "apps": list, "until": untils])) }
        else { print("\(clock.string(from: Date())) ready watching \(what)\(until)") }
    }
}

var watcher: Watch!
func cmdWatch() {
    if argv.contains("--help") || argv.contains("-h") {
        print("""
        usage: watch [--app NAME|BUNDLE_ID|PID]... [--until TEXT]... [--seconds N] [--values] [--json]
          One line per UI event, as it happens: app-launched/quit/focused, window-opened/closed/focused/minimized,
          sheet-opened/closed, title-changed, announced (VoiceOver announcements), and with --values
          value-changed for text, progress and level indicators. Dialogs, sheets and banners include what they
          say and their [buttons]. --app (repeatable; name matches as a prefix) limits it to those apps; default
          is every regular app plus system dialogs.
          --until TEXT (repeatable, case-insensitive substring of the line): print the first matching line and
          exit 0. A window that already matches when the watch starts counts ("already …").
          --seconds N: stop after N s; exit 124 if an --until never matched.
        """)
        exit(0)
    }
    guard AXIsProcessTrusted() else { fail("Accessibility permission missing for the host app (System Settings → Privacy & Security → Accessibility)") }
    setvbuf(stdout, nil, _IOLBF, 0)   // a pipe is block-buffered by default; every event must leave now
    signal(SIGPIPE, SIG_DFL)
    onTerminate { exit(0) }
    watcher = Watch()
    if let s = opt("seconds").flatMap(Double.init), s > 0 {
        DispatchQueue.main.asyncAfter(deadline: .now() + s) {
            if watcher.untils.isEmpty { exit(0) }
            print(watcher.asJSON ? json(["event": "timeout", "seconds": s]) : "\(watcher.clock.string(from: Date())) timeout after \(s.formatted())s — nothing matched")
            exit(124)
        }
    }
    watcher.start()
}

// MARK: - main

switch sub {
case "input": cmdInput()
case "displays": Task { await cmdDisplays() }
case "snapshot": Task { await cmdSnapshot() }
case "raw": cmdRaw()
case "capture": Task { await cmdCapture() }
case "lock": cmdLock()
case "watch": cmdWatch()
case "release-cursor": CGAssociateMouseAndMouseCursorPosition(1); exit(0)
default:
    print("usage: eye-capture displays | capture --rect x,y,w,h --out f.csv [--seconds N] | snapshot --rect x,y,w,h --out f.png | lock [--seconds N]")
    exit(sub.isEmpty ? 1 : 2)
}
// CFRunLoopRun (not dispatchMain): the lock's event tap is a run-loop source, and the main run
// loop also drains the main dispatch queue the other subcommands use.
CFRunLoopRun()
