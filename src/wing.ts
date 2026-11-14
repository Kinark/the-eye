/**
 * The words of a wing (eye_drive): one line of text that is one unbroken motion of the hand.
 * Parsed here into the moves eye-capture's Hand flies; `words` keeps each move as it was written, for the reply.
 */
const COMPASS: Record<string, number> = { e: 0, se: 45, s: 90, sw: 135, w: 180, nw: 225, n: 270, ne: 315, "→": 0, "↘": 45, "↓": 90, "↙": 135, "←": 180, "↖": 225, "↑": 270, "↗": 315 };
const PACE: Record<string, number> = { slow: 220, walk: 450, brisk: 700, fast: 1200 };
export const WING_WORDS = [
  '"Name" (fly to the thing called that; Button:"Name" to say which kind, #identifier by id)',
  "x,y (a point)", "N NE E SE S SW W NW or ↑↗→↘↓↙←↖, then a distance in points, or none to keep flying that way",
  "tap tap2 tap3 rtap down up", "scroll up|down|left|right <px>", "rest <ms>", "settle (until the screen is still)", "halt",
  "slow walk brisk fast or <n>/s (pace from here on)",
  "trackpad, where the hand is: pinch <scale> [ms] · rotate <degrees> [ms] · zoom (smart zoom) · swipe left|right|up|down · press [ms] (Force Touch, stage 1) · force [ms] (force click) · fling up|down|left|right <px> (scroll with momentum)",
  "until:\"expr\" [ms] (wait until it holds, default 2000) · check:\"expr\" (stop the wing unless it holds) · layer:\"label\" (go to that probe layer)",
].join(" · ");
const SIDES = ["up", "down", "left", "right"];
export function parseWing(s: string): { moves: any[]; words: string[] } | { error: string } {
  const tok = s.match(/(?:[A-Za-z]+:)?"[^"]*"|\S+/g) ?? [];
  const moves: any[] = [], words: string[] = [];
  const numAt = (i: number) => (i < tok.length && /^-?\d+(\.\d+)?$/.test(tok[i]) ? Number(tok[i]) : undefined);
  for (let i = 0; i < tok.length; i++) {
    const t = tok[i], l = t.toLowerCase();
    let m: any, w = t;
    const q = t.match(/^(?:([A-Za-z]+):)?"([^"]*)"$/);
    const verb = q?.[1]?.toLowerCase();
    // Exact words: the hand comes to rest and the server sends that one step the way eye_drive {steps} would.
    if (q && verb === "until") { const n = numAt(i + 1); m = { k: "exact", step: { op: "wait_until", expr: q[2], timeout_ms: n } }; if (n !== undefined) w += ` ${tok[++i]}`; }
    else if (q && verb === "check") m = { k: "exact", step: { op: "assert", expr: q[2] } };
    else if (q && verb === "layer") m = { k: "exact", step: { op: "move", on: q[2], ms: 250 } };
    else if (l === "pinch" || l === "rotate") {
      const v = numAt(i + 1), ms = numAt(i + 2);
      if (v === undefined || (l === "pinch" && v <= 0)) return { error: l === "pinch" ? `"pinch" needs a zoom factor, e.g. pinch 2 (spread to double) or pinch 0.5` : `"rotate" needs degrees, e.g. rotate 45 (+ = clockwise)` };
      m = { k: "exact", step: l === "pinch" ? { op: "pinch", scale: v, ms } : { op: "rotate", degrees: v, ms } };
      w += ` ${tok[++i]}`; if (ms !== undefined) w += ` ${tok[++i]}`;
    } else if (l === "zoom") m = { k: "exact", step: { op: "smart_zoom" } };
    else if (l === "swipe" || l === "fling") {
      const dir = tok[i + 1]?.toLowerCase(), n = numAt(i + 2);
      if (!SIDES.includes(dir) || (l === "fling" && n === undefined)) return { error: l === "swipe" ? `"swipe" needs a direction: swipe left` : `"fling" needs a direction and pixels, e.g. fling down 600` };
      if (l === "swipe") { m = { k: "exact", step: { op: "swipe", direction: dir } }; w += ` ${tok[++i]}`; }
      else { m = { k: "exact", step: { op: "scroll", dy: dir === "down" ? -n! : dir === "up" ? n! : 0, dx: dir === "right" ? -n! : dir === "left" ? n! : 0, momentum: true } }; w = `fling ${dir} ${n}`; i += 2; }
    } else if (l === "press" || l === "force") {
      const ms = numAt(i + 1);
      m = { k: "exact", step: { op: l === "press" ? "press" : "force_click", ms } };
      if (ms !== undefined) w += ` ${tok[++i]}`;
    }
    else if (q) m = { k: "thing", q: q[2], role: q[1] };
    else if (t.startsWith("#") && t.length > 1) m = { k: "thing", q: t.slice(1), id: true };
    else if (/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(t)) { const [x, y] = t.split(",").map(Number); m = { k: "to", x, y }; }
    else if (l in COMPASS) { const d = numAt(i + 1); m = { k: "dir", deg: COMPASS[l], dist: d }; if (d !== undefined) w += ` ${tok[++i]}`; }
    else if (/^tap[23]?$/.test(l)) m = { k: "tap", count: Number(l.slice(3) || 1) };
    else if (l === "rtap") m = { k: "tap", button: "right" };
    else if (l === "down" || l === "up" || l === "halt") m = { k: l };
    else if (l === "scroll") {
      const dir = tok[i + 1]?.toLowerCase(), n = numAt(i + 2);
      if (!["up", "down", "left", "right"].includes(dir) || n === undefined) return { error: `"scroll" needs a direction and pixels, e.g. scroll down 300` };
      m = { k: "scroll", dy: dir === "down" ? -n : dir === "up" ? n : 0, dx: dir === "right" ? -n : dir === "left" ? n : 0 };
      w = `scroll ${dir} ${n}`; i += 2;
    } else if (l === "rest" || l === "settle") {
      const n = numAt(i + 1);
      m = { k: l, ms: n ?? (l === "rest" ? 200 : 2000) };
      if (n !== undefined) w += ` ${tok[++i]}`;
    } else if (l in PACE) m = { k: "speed", v: PACE[l] };
    else if (/^\d+\/s$/.test(l)) m = { k: "speed", v: parseInt(l, 10) };
    else return { error: `"${t}" is not a move. A wing is words separated by spaces: ${WING_WORDS}` };
    moves.push(m); words.push(w);
  }
  return { moves, words };
}
