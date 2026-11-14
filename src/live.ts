// `the-eye live`: what a running recording sees, as lines. One line each time the picture starts moving, comes to
// rest (how long it moved, how many new frames, the worst gap) or hitches; made to be streamed by an agent's
// monitor, so it prints nothing while nothing happens. It only reads the recording's live file.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const HELP = `the-eye live [--run DIR] [--seconds N] [--until moving|still]

Prints one line per change of the newest recording (or the one in --run):
  3.20s MOVING
  3.95s still · moved 0.75s · 88 new frames (117 fps) · worst gap 9ms
  5.10s HITCH · a gap of 58ms in the last second (3 hitches)
  NOT SEEING: …
Waits for a recording when none runs. --seconds N exits after N seconds (124). --until exits 0 on the first such line.`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function liveCli(argv: string[], runs: string): Promise<number> {
  const opt = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
  if (argv.includes("--help") || argv.includes("-h")) { console.log(HELP); return 0; }
  const until = opt("until"), end = opt("seconds") ? Date.now() + Number(opt("seconds")) * 1000 : Infinity;
  const fixed = opt("run");
  const newest = (): string | undefined => {
    if (fixed) return join(fixed, "frames.csv.live.json");
    try {
      return readdirSync(runs).sort().reverse().slice(0, 6).map((d) => join(runs, d, "frames.csv.live.json"))
        .find((f) => existsSync(f) && Date.now() - statSync(f).mtimeMs < 1500);
    } catch { return undefined; }
  };
  let file: string | undefined, moving = false, from = 0, framesAt = 0, worst = 0, hitches = 0, dark = "";
  const say = (s: string) => { console.log(s); };
  while (Date.now() < end) {
    const f = newest();
    if (f !== file) {
      if (file) say("the recording ended");
      file = f; moving = false; hitches = 0; dark = "";
      if (file) say(`watching ${file.replace(/\/frames\.csv\.live\.json$/, "")}`);
    }
    if (!file) { await sleep(200); continue; }
    let l: any;
    try { l = JSON.parse(readFileSync(file, "utf8")); } catch { await sleep(100); continue; }
    const age = (Date.now() - statSync(file).mtimeMs) / 1000;
    const why = l.stream_error ? `the capture stream died (${l.stream_error})` : age > 1.5 ? "the recording ended" : "";
    if (why && fixed) { say(why === "the recording ended" ? why : `NOT SEEING: ${why}`); return 0; }
    if (why !== dark) { dark = why; if (why && why !== "the recording ended") say(`NOT SEEING: ${why}`); }
    if (!why) {
      const t = Number(l.t ?? 0), s = l.last_1s ?? {};
      if (l.moving && !moving) {
        moving = true; from = t; framesAt = Number(l.frames_total ?? 0); worst = -1;
        say(`${t.toFixed(2)}s MOVING`);
        if (until === "moving") return 0;
      }
      // The last second's worst gap also holds the stillness the motion began after: a gap only counts once the
      // motion has run longer than it.
      const gap = Number(s.max_gap_ms ?? 0), within = moving && gap <= (t - from) * 1000;
      if (within) worst = Math.max(worst, gap);
      if (!l.moving && moving) {
        moving = false;
        const dur = Math.max(0.001, t - from), n = Number(l.frames_total ?? 0) - framesAt;
        say(`${t.toFixed(2)}s still · moved ${dur.toFixed(2)}s · ${n} new frames (${(n / dur).toFixed(0)} fps)${worst >= 0 ? ` · worst gap ${worst.toFixed(0)}ms` : ""}`);
        if (until === "still") return 0;
      }
      const h = Number(s.hitches ?? 0);
      if (within && h > hitches) say(`${t.toFixed(2)}s HITCH · a gap of ${gap.toFixed(0)}ms in the last second (${h} hitch${h === 1 ? "" : "es"})`);
      hitches = h;
    }
    await sleep(100);
  }
  return 124;
}
