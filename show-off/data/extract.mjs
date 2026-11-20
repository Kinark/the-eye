// Turns one real the-eye run folder into the small JSON the show-off page replays.
//   bun show-off/data/extract.mjs <run folder> <from_s> <to_s> > show-off/data/open.json
// Nothing here is made up: every time comes from the run's own files, read with the server's own loader.
import { readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { loadUnder } from "../../src/under.ts";

const [dir, fromArg, toArg] = process.argv.slice(2);
if (!dir) { console.error("usage: extract.mjs <run folder> [from_s] [to_s]"); process.exit(1); }
const meta = JSON.parse(readFileSync(join(dir, "frames.csv.meta.json"), "utf8"));
const from = Number(fromArg ?? 0), to = Number(toArg ?? meta.span_seconds);
const r3 = (x) => Math.round(x * 1000) / 1000;
const within = (t) => t >= from && t <= to;

const lines = readFileSync(join(dir, "frames.csv"), "utf8").trim().split("\n");
const head = lines[0].split(","), col = (n) => head.indexOf(n);
const [T, S, X0, Y0, W, H] = ["t", "status", "bbox_x0", "bbox_y0", "bbox_w", "bbox_h"].map(col);
// [t, x, y, w, h] of everything that differs from the first frame, one entry per new image on screen.
const frames = lines.slice(1).map((l) => l.split(",")).filter((c) => c[S] === "c" && within(Number(c[T])))
  .map((c) => [r3(Number(c[T])), Number(c[X0]), Number(c[Y0]), Number(c[W]), Number(c[H])]);

const u = loadUnder(dir, Number(meta.t0_wall), Number(meta.t0_mach));
const swaps = u.swaps.filter(within), changes = (u.changes ?? []).filter(within);
// The same pairing the report uses (carried() in src/under.ts): each change rides the next frame.
const carriedAt = new Set();
for (let i = 0, k = 0; i < changes.length; i++) {
  while (k < swaps.length && swaps[k] < changes[i]) k++;
  if (k < swaps.length) carriedAt.add(k);
}

process.stdout.write(JSON.stringify({
  run: basename(dir.replace(/\/$/, "")),
  refresh_hz: meta.refresh_hz,
  rect: meta.rect_points,
  from, to,
  frames,
  commits: u.commits.filter((c) => within(c.t)).map((c) => [r3(c.t), r3(c.ms)]),
  swaps: swaps.map(r3),
  carried: [...carriedAt].sort((a, b) => a - b),
  cycles: u.cycles.filter((c) => within(c.t)).map((c) => [r3(c.t), r3(c.ms), c.stall ? 1 : 0]),
}) + "\n");
