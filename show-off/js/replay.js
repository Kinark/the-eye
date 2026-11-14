// A real recording, replayed. data/open.json is one the-eye run reduced by data/extract.mjs; data/open-report.txt is
// the report the-eye returned for it. Nothing here is authored: the page only moves a playhead over measurements.
import { onFrame } from "./meter.js";
import { MOTION, drawStage, drawTimeline } from "./replay-draw.js";

const $ = (id) => document.getElementById(id);

export async function replay() {
  const [data, text] = await Promise.all([
    fetch("/data/open.json").then((r) => r.json()),
    fetch("/data/open-report.txt").then((r) => r.text()),
  ]);
  const stage = $("replay-canvas"), line = $("timeline"), play = $("play"), slow = $("slow");
  const rest = data.frames[data.frames.length - 1];
  let t = data.to, playing = false, dirty = true, last = MOTION[1], timed = false;

  // Each report line lights when the playhead reaches the moment it speaks of.
  const lines = text.replace(/\n+$/, "").split("\n").map((s) => {
    const span = document.createElement("span");
    span.textContent = s;
    const at = [...s.matchAll(/(\d+\.\d+)s/g)].map((m) => +m[1]).find((v) => v >= data.from && v <= data.to);
    if (s.startsWith("under the pixels")) { last = MOTION[1]; timed = false; }
    else if (at !== undefined) { last = at; timed = true; }
    return { span, at: timed ? last : MOTION[1] };
  });
  $("replay-report").replaceChildren(...lines.map((l) => l.span));

  const inMotion = (time) => time >= MOTION[0] && time <= MOTION[1] && time <= t;
  const count = (list, time = (v) => v, keep = () => true) => list.filter((v) => inMotion(time(v)) && keep(v)).length;
  const frameAt = (time) => { let f = data.frames[0]; for (const g of data.frames) { if (g[0] > time) break; f = g; } return f; };

  function draw() {
    dirty = false;
    const f = frameAt(t);
    drawStage(stage, f, rest);
    drawTimeline(line, data, t);
    $("replay-extent").textContent = f[3] > 0 ? `${f[3]} × ${f[4]}pt` : "no change on screen yet";
    $("replay-t").textContent = `${t.toFixed(2)}s`;
    $("n-commits").textContent = count(data.commits, (v) => v[0]);
    $("n-swaps").textContent = count(data.swaps);
    $("n-carried").textContent = count(data.carried, (i) => data.swaps[i]);
    $("n-cycles").textContent = count(data.cycles, (v) => v[0]);
    $("n-stalls").textContent = count(data.cycles, (v) => v[0], (v) => v[2] === 1);
    for (const l of lines) l.span.classList.toggle("lit", t >= l.at);
    line.setAttribute("aria-valuenow", t.toFixed(2));
    line.setAttribute("aria-valuetext", `${t.toFixed(2)} seconds`);
    play.textContent = playing ? "Pause" : t >= data.to ? "Play the recording" : "Carry on";
  }
  const go = (to) => { t = Math.min(data.to, Math.max(data.from, to)); dirty = true; };

  play.addEventListener("click", () => { if (!playing && t >= data.to) t = data.from; playing = !playing; dirty = true; });
  slow.addEventListener("click", () => slow.setAttribute("aria-pressed", String(slow.getAttribute("aria-pressed") !== "true")));
  onFrame((_, dt) => {
    if (playing) {
      go(t + (Math.min(dt, 100) / 1000) * (slow.getAttribute("aria-pressed") === "true" ? 0.25 : 1));
      if (t >= data.to) playing = false;
    }
    if (dirty) draw();
  });

  // Scrubbing: the playhead is under the pointer, 1:1, for as long as it is held.
  const seek = (e) => { const r = line.getBoundingClientRect(); playing = false; go(data.from + ((e.clientX - r.left) / r.width) * (data.to - data.from)); };
  line.addEventListener("pointerdown", (e) => { line.setPointerCapture(e.pointerId); seek(e); });
  line.addEventListener("pointermove", (e) => { if (line.hasPointerCapture(e.pointerId)) seek(e); });
  line.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 0.1 : 1 / data.refresh_hz;
    const to = { ArrowLeft: t - step, ArrowDown: t - step, ArrowRight: t + step, ArrowUp: t + step, Home: data.from, End: data.to }[e.key];
    if (to === undefined) return;
    e.preventDefault(); playing = false; go(to);
  });
  new ResizeObserver(() => { dirty = true; }).observe(stage);
  new ResizeObserver(() => { dirty = true; }).observe(line);
}
