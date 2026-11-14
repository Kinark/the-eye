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
console.log(bad ? `${bad} FAILED` : "all wing words parse");
process.exit(bad ? 1 : 0);
