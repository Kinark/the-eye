// The words of a wing → the moves the hand flies. node test/wing.mjs
import { parseWing } from "../src/wing.ts";
let bad = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? "ok" : "FAIL"} ${name}${ok ? "" : `\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`}`);
};
const moves = (s) => { const r = parseWing(s); return "error" in r ? r.error : r.moves; };
eq("things by name, kind and id", moves('"Save As…" Button:"OK" #close-button'),
  [{ k: "thing", q: "Save As…" }, { k: "thing", q: "OK", role: "Button" }, { k: "thing", q: "close-button", id: true }]);
eq("a name may hold spaces and words that are moves", moves('"tap down E" tap'), [{ k: "thing", q: "tap down E" }, { k: "tap", count: 1 }]);
eq("a point", moves("412.5,300"), [{ k: "to", x: 412.5, y: 300 }]);
eq("a heading with and without a distance", moves("E 120 NW ↓ 40 ←"),
  [{ k: "dir", deg: 0, dist: 120 }, { k: "dir", deg: 225 }, { k: "dir", deg: 90, dist: 40 }, { k: "dir", deg: 180 }]);
eq("presses", moves("tap tap2 tap3 rtap down up"),
  [{ k: "tap", count: 1 }, { k: "tap", count: 2 }, { k: "tap", count: 3 }, { k: "tap", button: "right" }, { k: "down" }, { k: "up" }]);
eq("fingers: a line, y down, and they stay", moves("fingers down 60 fingers left 40 lift"), [{ k: "fingers", pts: [[0, 60]] }, { k: "fingers", pts: [[-40, 0]] }, { k: "lift" }]);
eq("fingers: several offsets are one stroke", moves("fingers 30,-12 -20,25 5,-30 flick tap"), [{ k: "fingers", pts: [[30, -12], [-20, 25], [5, -30]], flick: true }, { k: "tap", count: 1 }]);
eq("fingers: a compass word and a flick", moves("fingers N 50 flick"), [{ k: "fingers", pts: [[0, -50]], flick: true }]);
eq("fingers: orbit and wander", moves("fingers orbit 30 -2 fingers wander 25 fingers wander 20 900"), [{ k: "fingers", orbit: 30, turns: -2 }, { k: "fingers", wander: 25, ms: 1500 }, { k: "fingers", wander: 20, ms: 900 }]);
eq("fingers: words kept, stroke whole", parseWing("fingers 3,4 5,6 rest 100 fingers orbit 20").words, ["fingers 3,4 5,6", "rest 100", "fingers orbit 20"]);
eq("fingers: a wander cannot flick", !!parseWing("fingers wander 20 flick").error, true);
eq("fingers: words kept", parseWing("fingers down 60 flick rest 100 lift").words, ["fingers down 60 flick", "rest 100", "lift"]);
eq("fingers: needs a way", !!parseWing("fingers 60").error, true);
eq("fingers: play, bare", moves("fingers play"), [{ k: "fingers", motif: "play" }]);
eq("fingers: play with a mood, a size and a way", moves("fingers play wild 90 left rest 500"), [{ k: "fingers", motif: "play", mood: "wild", amp: 90, deg: 180 }, { k: "rest", ms: 500 }]);
eq("fingers: play, words kept", parseWing("fingers play gentle rest 500 fingers calm lift").words, ["fingers play gentle", "rest 500", "fingers calm", "lift"]);
eq("fingers: calm", moves("fingers calm lift"), [{ k: "fingers", motif: "calm" }, { k: "lift" }]);
eq("fingers: go a way", moves("fingers go NW"), [{ k: "fingers", motif: "go", deg: 225 }]);
eq("fingers: go needs a way", !!parseWing("fingers go").error, true);
eq("fingers: a wave along", moves("fingers wave 45 2.6 up along -200,40 900"), [{ k: "fingers", motif: "wave", amp: 45, hz: 2.6, deg: 270, along: [-200, 40], ms: 900 }]);
eq("fingers: stir the other way, roam", moves("fingers stir 40 -1.5 fingers roam 120"), [{ k: "fingers", motif: "stir", amp: 40, hz: -1.5 }, { k: "fingers", motif: "roam", amp: 120 }]);
eq("fingers: a wave needs a size", !!parseWing("fingers wave").error, true);
eq("fingers: along needs where", !!parseWing("fingers roam 60 along").error, true);
eq("flick alone is refused", !!parseWing("scroll down 10 flick").error, true);
eq("scroll: down is negative, like the wheel", moves("scroll down 300 scroll left 40"), [{ k: "scroll", dy: -300, dx: 0 }, { k: "scroll", dy: 0, dx: 40 }]);
eq("rest, settle, halt, with and without a number", moves("rest rest 80 settle settle 500 halt"),
  [{ k: "rest", ms: 200 }, { k: "rest", ms: 80 }, { k: "settle", ms: 2000 }, { k: "settle", ms: 500 }, { k: "halt" }]);
eq("pace", moves("slow walk brisk fast 300/s"), [220, 450, 700, 1200, 300].map((v) => ({ k: "speed", v })));
eq("a drag, steered", moves('"Volume" down E 80 rest 200 W 30 up'),
  [{ k: "thing", q: "Volume" }, { k: "down" }, { k: "dir", deg: 0, dist: 80 }, { k: "rest", ms: 200 }, { k: "dir", deg: 180, dist: 30 }, { k: "up" }]);
eq("words are kept as written, one per move", parseWing('"7" tap E 20 scroll up 5').words, ['"7"', "tap", "E 20", "scroll up 5"]);
eq("an unknown word is named", String(moves("E wiggle")).startsWith('"wiggle" is not a move'), true);
eq("scroll without a direction says what it needs", String(moves("scroll 300")).includes("scroll down 300"), true);
eq("an empty wing is no moves", moves("   "), []);
// Words that are not flown: each is one exact step, run between the stretches the hand flies in one motion.
const steps = (s) => { const r = parseWing(s); return "error" in r ? r.error : r.moves.map((m) => (m.k === "exact" ? m.step : m.k)); };
eq("waiting on the screen and checking it", steps('until:"a>100" 800 until:"!live.moving" check:"h.role"'),
  [{ op: "wait_until", expr: "a>100", timeout_ms: 800 }, { op: "wait_until", expr: "!live.moving" }, { op: "assert", expr: "h.role" }]);
eq("a probe layer as the aim", steps('layer:"puck" tap'), [{ op: "move", on: "puck", ms: 250 }, "tap"]);
eq("trackpad gestures", steps("pinch 1.5 pinch 0.5 400 rotate 45 zoom swipe left"),
  [{ op: "pinch", scale: 1.5 }, { op: "pinch", scale: 0.5, ms: 400 }, { op: "rotate", degrees: 45 }, { op: "smart_zoom" }, { op: "swipe", direction: "left" }]);
eq("a fling is a scroll with momentum", steps("fling down 300"), [{ op: "scroll", dy: -300, dx: 0, momentum: true }]);
eq("pressure", steps("press press 600 force"), [{ op: "press" }, { op: "press", ms: 600 }, { op: "force_click" }]);
eq("a gesture between two flights keeps its place", steps('"Map" pinch 2 E 40'), ["thing", { op: "pinch", scale: 2 }, "dir"]);
eq("pinch without a factor says what it needs", String(steps("pinch")).includes("pinch 2"), true);
eq("swipe without a direction says what it needs", String(steps("swipe")).includes("swipe left"), true);
console.log(bad ? `${bad} FAILED` : "all wing words parse");
process.exit(bad ? 1 : 0);
