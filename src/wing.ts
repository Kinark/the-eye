/**
 * The words of a wing (eye_drive): one line of text that is one unbroken motion of the hand.
 * Parsed here into the moves eye-capture's Hand flies; `words` keeps each move as it was written, for the reply.
 */
const COMPASS: Record<string, number> = { e: 0, se: 45, s: 90, sw: 135, w: 180, nw: 225, n: 270, ne: 315, "→": 0, "↘": 45, "↓": 90, "↙": 135, "←": 180, "↖": 225, "↑": 270, "↗": 315 };
const PACE: Record<string, number> = { slow: 220, walk: 450, brisk: 700, fast: 1200 };
export const WING_WORDS = [
  '"Name" (fly to the thing called that; Button:"Name" to say which kind, #identifier by id)',
  "x,y (a point)", "N NE E SE S SW W NW or ↑↗→↘↓↙←↖, then a distance in points, or none to keep flying that way",
  "tap tap2 tap3 rtap down up", "scroll up|down|left|right <px> (the page goes that way: one gesture, lands and lifts)",
  "fingers … (two fingers ON THE TRACKPAD, in two dimensions; they land and stay down, and what is under them follows as under a drag): fingers up|down|left|right|<compass> <pt> (a line) · fingers <dx>,<dy> <dx>,<dy> … (ONE curved stroke through those offsets, y down, never stopping at any) · fingers orbit <r> [turns] (a circle back to where it began; negative turns = the other way) · fingers wander <r> [ms] (roams within r of where it is, differently every time, and comes back) · fingers like:\"last\" [n] (plays back a touch the USER made, as they made it: recorded by any session that only watched; \"last\" or a run folder, n = which touch, default the longest; one that left at speed is thrown again: the fingers lift and the thing coasts) · flick right after a stroke (it leaves at speed and coasts) · lift · fingers play [gentle|lively|wild] [size] [up|down|left|right] (THEY PLAY BY THEMSELVES, also while you think, as a person does with a thing that stretches and wobbles: in phrases that run into each other without a stop, each chosen from what the screen did under the last one: a pull to see what it does and further while it grows, a wave where it answers that swells and goes on while it gives more, a shake, a slow slide across, further than it has been, held stretched and let go, thrown with a flick; they lift to watch it settle and land again by themselves; a place where it popped is crossed again slowly; a stroke you write meanwhile sends them there and they play on from it) · one thing kept up until the next word (for a moment, not to fill time: a held wave is a tremor): fingers wave <±pt> [times a second] [N|S = up and down] · fingers stir <r> [turns a second, negative = the other way] · fingers roam <r> · fingers go <way> (on and on at the pace) · fingers calm (play, or whatever they kept up, dies away; they stay down) · add `along <dx>,<dy> [ms]` to a wave, stir or roam and the place travels meanwhile",
  "rest <ms>", "settle (until the screen is still)", "halt",
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
    } else if (l === "fingers") {
      // Where the fingers go, in points on the trackpad, y down, from where they are. The hand turns that into the
      // scroll a real trackpad would send under the machine's Natural scrolling setting.
      const PAIR = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/;
      const d = tok[i + 1]?.toLowerCase() ?? "", n = numAt(i + 2);
      const like = /^like:"([^"]*)"$/i.exec(tok[i + 1] ?? "");
      if (like) {
        // A touch the user made, recorded by a session that watched (its run folder, or "last"); n = which touch.
        const n1 = numAt(i + 2);
        m = { k: "fingers", like: like[1] || "last", n: n1 };
        w = `fingers ${tok[i + 1]}${n1 !== undefined ? ` ${n1}` : ""}`; i += n1 !== undefined ? 2 : 1;
      } else if (PAIR.test(d)) {
        // One stroke through every offset in turn, as a curve: it does not stop at any of them.
        const pts: number[][] = [];
        while (PAIR.test(tok[i + 1] ?? "")) { const x = PAIR.exec(tok[++i])!; pts.push([Number(x[1]), Number(x[2])]); w += ` ${tok[i]}`; }
        if (!pts.some((q) => q[0] || q[1])) return { error: `"${w}" goes nowhere` };
        m = { k: "fingers", pts };
      } else if (d === "wave" || d === "stir" || d === "roam") {
        // Something the fingers KEEP doing where they are, until told otherwise: the wing does not wait for it to
        // end (it has none), and the next call changes it without a seam.
        if (n === undefined || n <= 0) return { error: `"fingers ${d}" needs a size in points: ${d === "wave" ? "fingers wave 45 2.6 (±45pt, 2.6 times a second; then N or S for up-and-down)" : d === "stir" ? "fingers stir 40 1.5 (a circle of 40pt, 1.5 turns a second; a negative rate turns the other way)" : "fingers roam 120 (anywhere within 120pt)"}` };
        m = { k: "fingers", motif: d, amp: n };
        w = `fingers ${d} ${n}`; i += 2;
        if (d !== "roam") {
          const hz = numAt(i + 1);
          if (hz !== undefined) { if (!hz) return { error: `"${w} 0": a ${d} that never comes round is not one` }; m.hz = hz; w += ` ${hz}`; i += 1; }
        }
        if (d === "wave") {
          const ax = tok[i + 1]?.toLowerCase() ?? "";
          const deg = SIDES.includes(ax) ? { right: 0, down: 90, left: 180, up: 270 }[ax as "up"] : ax in COMPASS ? COMPASS[ax] : undefined;
          if (deg !== undefined) { m.deg = deg; w += ` ${tok[i + 1]}`; i += 1; }
        }
        // …and meanwhile the place itself travels: fingers wave 30 3 along -200,40 [ms].
        if (tok[i + 1]?.toLowerCase() === "along") {
          const to = PAIR.exec(tok[i + 2] ?? "");
          if (!to) return { error: `"along" needs where the place goes meanwhile: ${w} along -200,40 [ms]` };
          m.along = [Number(to[1]), Number(to[2])]; w += ` along ${tok[i + 2]}`; i += 2;
          const ms = numAt(i + 1);
          if (ms !== undefined && ms > 0) { m.ms = ms; w += ` ${ms}`; i += 1; }
        }
      } else if (d === "go") {
        // They keep going that way at the pace, until the next word (or as far as a trackpad is wide, several times over).
        const way = tok[i + 2]?.toLowerCase() ?? "";
        const deg = SIDES.includes(way) ? { right: 0, down: 90, left: 180, up: 270 }[way as "up"] : way in COMPASS ? COMPASS[way] : undefined;
        if (deg === undefined) return { error: `"fingers go" needs a way: fingers go down · fingers go NW (they keep going until the next word: until:"…", another fingers move, lift)` };
        m = { k: "fingers", motif: "go", deg };
        w = `fingers go ${tok[i + 2]}`; i += 2;
      } else if (d === "play") {
        // They play by themselves until told otherwise: a stream of small strokes, each decided from what the screen
        // did under the last ones. Said again while they play, it only changes how (size, mood) or sends them a way.
        m = { k: "fingers", motif: "play" }; w = "fingers play"; i += 1;
        for (;;) {
          const x = tok[i + 1]?.toLowerCase() ?? "", size = numAt(i + 1);
          if (["gentle", "lively", "wild"].includes(x) && !m.mood) m.mood = x;
          else if (size !== undefined && size > 0 && m.amp === undefined) m.amp = size;
          else if (SIDES.includes(x) && m.deg === undefined) m.deg = { right: 0, down: 90, left: 180, up: 270 }[x as "up"];
          else break;
          w += ` ${tok[i + 1]}`; i += 1;
        }
      } else if (d === "calm") {
        // Whatever they kept doing dies away; they stay down where they are.
        m = { k: "fingers", motif: "calm" };
        w = "fingers calm"; i += 1;
      } else if (d === "orbit" || d === "wander") {
        if (n === undefined || n <= 0) return { error: d === "orbit" ? `"fingers orbit" needs a radius in points, then turns if not one (negative = the other way round): fingers orbit 30 2` : `"fingers wander" needs how far it may roam in points, then for how long in ms (default 1500): fingers wander 25 2000` };
        const x = numAt(i + 3);
        m = d === "orbit" ? { k: "fingers", orbit: n, turns: x || 1 } : { k: "fingers", wander: n, ms: x !== undefined && x > 0 ? x : 1500 };
        w = `fingers ${d} ${n}${x !== undefined ? ` ${x}` : ""}`; i += x !== undefined ? 3 : 2;
      } else if ((SIDES.includes(d) || d in COMPASS) && n !== undefined && n > 0) {
        const deg = SIDES.includes(d) ? { right: 0, down: 90, left: 180, up: 270 }[d as "up"] : COMPASS[d];
        const r = (v: number) => Math.round(v * n * 100) / 100 + 0;
        m = { k: "fingers", pts: [[r(Math.cos((deg * Math.PI) / 180)), r(Math.sin((deg * Math.PI) / 180))]] };
        w = `fingers ${d} ${n}`; i += 2;
      } else return { error: `"fingers" needs where they go: fingers down 60 · fingers NE 40 · fingers 30,-12 -20,25 5,-30 (one curved stroke through those offsets, y down) · fingers orbit 30 [turns] · fingers wander 25 [ms] · or let them play by what they see: fingers play [gentle|lively|wild] [size] [up|down|left|right] · or one thing kept up: fingers wave 45 2.6 · fingers stir 40 1.5 · fingers roam 120 · fingers go W · fingers calm` };
      if (tok[i + 1]?.toLowerCase() === "flick") {
        if (m.wander) return { error: `a wander ends where it began, at rest: it cannot flick` };
        if (m.motif) return { error: `"${w}" goes on until told otherwise: it has no end to flick from. Make a stroke after it and flick that: fingers down 120 flick` };
        m.flick = true; w += " flick"; i += 1;
      }
    } else if (l === "lift") m = { k: "lift" };
    else if (l === "flick") return { error: `"flick" goes right after a fingers move: fingers down 120 flick` };
    else if (l === "rest" || l === "settle") {
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
