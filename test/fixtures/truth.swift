// Ground truth for test/physics.mjs, from the platform itself: SwiftUI's own Spring and UnitCurve evaluated at
// 120Hz over a 360pt travel (20 → 380). Prints JSON: [{name, kind, ...params, samples: [[t, x], ...]}].
import SwiftUI

var out: [String] = []
func emit(_ name: String, _ kind: String, _ params: String, seconds: Double, _ f: (Double) -> Double) {
    var s: [String] = []
    var i = 0
    while Double(i) / 120 <= seconds { let t = Double(i) / 120; s.append("[\(t),\(20 + 360 * f(t))]"); i += 1 }
    out.append("{\"name\":\"\(name)\",\"kind\":\"\(kind)\",\(params),\"samples\":[\(s.joined(separator: ","))]}")
}
for (name, d, b) in [("smooth", 0.5, 0.0), ("snappy", 0.5, 0.15), ("bouncy", 0.5, 0.3), ("quick-bouncy", 0.3, 0.3),
                     ("wobbly", 0.4, 0.6), ("ringing", 0.35, 0.8), ("heavy", 0.5, -0.4), ("slow-smooth", 0.9, 0.0)] {
    let sp = Spring(duration: d, bounce: b)
    emit(name, "spring", "\"duration\":\(d),\"bounce\":\(b),\"zeta\":\(sp.dampingRatio)", seconds: sp.settlingDuration + 0.15) { sp.value(target: 1.0, time: $0) }
}
do { // a flick: released already moving at 6× its travel per second
    let sp = Spring(duration: 0.45, bounce: 0.2)
    emit("flicked", "spring", "\"duration\":0.45,\"bounce\":0.2,\"zeta\":\(sp.dampingRatio),\"v0\":6", seconds: sp.settlingDuration + 0.15) { sp.value(target: 1.0, initialVelocity: 6.0, time: $0) }
}
for (name, c, d) in [("easeInOut", UnitCurve.easeInOut, 0.35), ("easeOut", .easeOut, 0.3), ("easeIn", .easeIn, 0.4), ("linear", .linear, 0.25),
                     ("css-ease", .bezier(startControlPoint: UnitPoint(x: 0.25, y: 0.1), endControlPoint: UnitPoint(x: 0.25, y: 1)), 0.3),
                     ("custom", .bezier(startControlPoint: UnitPoint(x: 0.7, y: 0), endControlPoint: UnitPoint(x: 0.1, y: 1)), 0.6)] {
    emit(name, "curve", "\"duration\":\(d)", seconds: d + 0.1) { c.value(at: min(1, $0 / d)) }
}
do { // x += (target - x) * 0.12 every 120Hz frame
    emit("lerp", "lerp", "\"per_frame\":0.12", seconds: 0.6) { 1 - pow(1 - 0.12, $0 * 120) }
}
print("[\(out.joined(separator: ","))]")
