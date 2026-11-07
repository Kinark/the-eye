// eye-capture — native half of the-eye MCP.
//
// Subcommands (all output is JSON on stdout unless noted):
//   displays
//   capture  --rect x,y,w,h [--display ID] [--seconds N] [--fps 120] --out run.csv
//            [--keyframes-dir DIR --keyframe-ms 100] [--step N]
//            Streams one CSV row per ScreenCaptureKit frame callback until --seconds elapse or
//            SIGINT/SIGTERM, then writes run.csv.meta.json and prints it.
//   snapshot --rect x,y,w,h [--display ID] --out shot.png
//   lock     [--seconds N] [--allow synthetic|tagged]
//            Drops PHYSICAL pointer input (moves, clicks, scroll, gestures) until timeout, SIGTERM,
//            or the user presses Esc. Keyboard stays live. Synthetic events pass: those tagged with
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

/// Logs the pointer position at `hz` and — only when the pointer has moved to a new spot, at most
/// `axHz` times a second — the accessibility element under it. AX hit-tests are answered on the
/// TARGET app's main thread, so they're rate-limited to keep the measurement honest.
final class CursorSampler {
    let path: String, hz: Double, axHz: Double
    var running = true
    let done = DispatchSemaphore(value: 0)
    init(path: String, hz: Double, axHz: Double) { self.path = path; self.hz = hz; self.axHz = axHz }

    func start() {
        Thread { [self] in
            FileManager.default.createFile(atPath: path, contents: nil)
            guard let h = FileHandle(forWritingAtPath: path) else { done.signal(); return }
            h.write("t_mach,x,y,buttons,ax_pid,ax_role,ax_label\n".data(using: .utf8)!)
            let sys = AXUIElementCreateSystemWide()
            AXUIElementSetMessagingTimeout(sys, 0.05)
            var lastAX = -Double.infinity
            var lastAXPos = CGPoint(x: -9999, y: -9999)
            var axPid: Int32 = 0, axRole = "", axLabel = ""
            var buf = ""
            let period = 1.0 / max(1, hz)
            while running {
                let now = machSeconds(mach_absolute_time())
                let p = CGEvent(source: nil)?.location ?? .zero
                let buttons = NSEvent.pressedMouseButtons
                let moved = hypot(p.x - lastAXPos.x, p.y - lastAXPos.y) > 6
                if axHz > 0, moved, now - lastAX >= 1 / axHz {
                    lastAX = now; lastAXPos = p
                    var el: AXUIElement?
                    if AXUIElementCopyElementAtPosition(sys, Float(p.x), Float(p.y), &el) == .success, let el {
                        AXUIElementGetPid(el, &axPid)
                        axRole = Self.attr(el, kAXRoleAttribute) ?? ""
                        // SwiftUI leaves are often unlabeled: take the first label found on the
                        // element or up to 3 ancestors, prefixed with how far up it was ("^2 Timer").
                        axLabel = ""
                        var cur: AXUIElement? = el
                        for depth in 0..<4 {
                            guard let c = cur else { break }
                            if let l = [kAXTitleAttribute, kAXDescriptionAttribute, kAXIdentifierAttribute, kAXHelpAttribute]
                                .lazy.compactMap({ Self.attr(c, $0) }).first(where: { !$0.isEmpty }) {
                                axLabel = depth == 0 ? l : "^\(depth) \(l)"; break
                            }
                            var parent: CFTypeRef?
                            cur = AXUIElementCopyAttributeValue(c, kAXParentAttribute as CFString, &parent) == .success
                                ? (parent as! AXUIElement?) : nil
                        }
                    } else { axPid = 0; axRole = ""; axLabel = "" }
                }
                let clean = { (s: String) in String(s.prefix(60)).replacingOccurrences(of: ",", with: " ").replacingOccurrences(of: "\n", with: " ") }
                buf += String(format: "%.5f,%.1f,%.1f,%d,%d,%@,%@\n", now, p.x, p.y, buttons, axPid, clean(axRole), clean(axLabel))
                if buf.utf8.count > 16_000 { h.write(buf.data(using: .utf8)!); buf = "" }
                Thread.sleep(forTimeInterval: period)
            }
            h.write(buf.data(using: .utf8)!)
            try? h.close()
            done.signal()
        }.start()
    }
    func stop() { running = false; _ = done.wait(timeout: .now() + 1) }
    static func attr(_ el: AXUIElement, _ name: String) -> String? {
        var v: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success, let v else { return nil }
        return (v as? String) ?? (v as? NSNumber)?.stringValue
    }
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

// MARK: - lock

let eyeTag: Int64 = 0x45594521
let legacyTag: Int64 = 0x4E4E4452
let pointerTypes: Set<UInt32> = [1, 2, 3, 4, 5, 6, 7, 22, 23, 24, 25, 26, 27, 29, 30, 31, 32]
var lockTap: CFMachPort?
var allowSynthetic = true
/// Strict lock (while a test drives the pointer): the physical keyboard is blocked too (keys, modifiers, media
/// keys), Esc does NOT release, and only the-eye's tagged events pass. Ends on timeout or signal only.
var lockStrict = false
let keyTypes: Set<UInt32> = [10, 11, 12, 14]
var blocked = 0, passed = 0
var pidCounts: [Int64: Int] = [:] // source pid → pointer events seen (diagnostics: physical = 0)
var blockedTypes: [UInt32: Int] = [:]
/// Strict lock: where the cursor must stay (lock start, then wherever the-eye's own events last put it).
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
    if !lockStrict, type == .keyDown, event.getIntegerValueField(.keyboardEventKeycode) == 53 {
        print(lockReport("escape"))
        exit(0)
    }
    // Strict: EVERY event type is tapped (trackpad gesture phases, force touch, keys, …), not just the pointer list.
    guard lockStrict || pointerTypes.contains(type.rawValue) else { return Unmanaged.passUnretained(event) }
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
    // The window server moves the cursor itself before any tap sees the event: dropping the event stops clicks,
    // not the arrow. In strict mode put it straight back where the test left it.
    if lockStrict, isMove, let p = heldCursor { CGWarpMouseCursorPosition(p) }
    return nil
}

func cmdLock() {
    let seconds = min(opt("seconds").flatMap(Double.init) ?? 60, 600)
    lockStrict = opt("strict") == "1"
    if lockStrict { heldCursor = CGEvent(source: nil)?.location }
    allowSynthetic = !lockStrict && (opt("allow") ?? "synthetic") != "tagged"
    var mask: CGEventMask = lockStrict ? ~CGEventMask(0) : 0
    for b in 0..<64 where !lockStrict {
        let t = UInt32(b)
        let wanted = pointerTypes.contains(t) || b == 10 || (lockStrict && keyTypes.contains(t))
        if wanted { mask |= CGEventMask(1) << CGEventMask(b) }
    }
    guard let tap = CGEvent.tapCreate(tap: .cghidEventTap, place: .headInsertEventTap, options: .defaultTap,
                                      eventsOfInterest: mask, callback: lockCallback, userInfo: nil) else {
        fail("cannot create event tap — grant Accessibility permission to the host app")
    }
    lockTap = tap
    CFRunLoopAddSource(CFRunLoopGetMain(), CFMachPortCreateRunLoopSource(nil, tap, 0), .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)
    if opt("overlay") != "0" { showLockOverlay(strict: lockStrict, until: Date().addingTimeInterval(seconds)) }
    if lockStrict {
        // Backstop for movement that reaches the cursor without a tappable event: re-pin it every 8 ms.
        let pin = Timer(timeInterval: 0.008, repeats: true) { _ in
            guard let want = heldCursor, let now = CGEvent(source: nil)?.location else { return }
            if abs(now.x - want.x) > 0.5 || abs(now.y - want.y) > 0.5 { CGWarpMouseCursorPosition(want) }
        }
        RunLoop.main.add(pin, forMode: .common)
    }
    FileHandle.standardError.write((lockStrict
        ? "eye-capture: physical pointer + keyboard locked for \(seconds)s (strict: no Esc)\n"
        : "eye-capture: physical pointer locked for \(seconds)s (Esc ends)\n").data(using: .utf8)!)
    let end: (String) -> Void = { why in
        print(lockReport(why))
        exit(0)
    }
    onTerminate { end("signal") }
    DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { end("timeout") }
}

/// Tells the user a test owns their input: a translucent orange wash over every screen, a breathing edge glow, a
/// sweeping sheen, a frame, and a bottom-centre pill with a pulsing dot. Click-through, every Space, every display,
/// and excluded from sharing, so screen captures never see it (it never adds pixels to a measurement).
var lockOverlayWindows: [NSWindow] = []
func showLockOverlay(strict: Bool, until: Date) {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    app.finishLaunching()
    let f = DateFormatter(); f.dateFormat = "HH:mm:ss"
    let message = strict
        ? "the-eye is testing — trackpad & keyboard locked until \(f.string(from: until))"
        : "the-eye is testing — trackpad locked until \(f.string(from: until)) · Esc releases"
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
        pill.frame = CGRect(x: (fr.width - textW - 56) / 2, y: 22, width: textW + 56, height: 32)
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
        root.addSublayer(pill)
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
    /// Topmost on-screen window under a global top-left point (CGWindowList is front to back).
    func owner(at p: CGPoint) -> [String: Any]? {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
        for w in list {
            guard let b = w[kCGWindowBounds as String] as? [String: CGFloat],
                  ((w[kCGWindowAlpha as String] as? Double) ?? 1) > 0,
                  // The lock overlay is ours and click-through: never the window a press lands on.
                  (w[kCGWindowOwnerName as String] as? String) != "eye-capture" else { continue }
            let r = CGRect(x: b["X"] ?? 0, y: b["Y"] ?? 0, width: b["Width"] ?? 0, height: b["Height"] ?? 0)
            guard r.contains(p) else { continue }
            return ["pid": w[kCGWindowOwnerPID as String] ?? 0, "owner": w[kCGWindowOwnerName as String] ?? "",
                    "layer": w[kCGWindowLayer as String] ?? 0, "number": w[kCGWindowNumber as String] ?? 0]
        }
        return nil
    }
    /// A press with `require_pid` is only posted when that process owns the topmost window at the point.
    func pressAllowed(_ c: [String: Any], at p: CGPoint) -> String? {
        guard let want = (c["require_pid"] as? NSNumber)?.intValue else { return nil }
        let o = owner(at: p)
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
        case "owner":
            let p = CGPoint(x: num("x", pointer().x), y: num("y", pointer().y))
            var o = owner(at: p) ?? [:]
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
