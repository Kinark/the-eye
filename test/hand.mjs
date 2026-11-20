// bun test/hand.mjs — the hand that plays by itself (`fingers play`) and what must stop it, checked at the helper:
// `eye-capture input` driven directly over a panel that logs the scroll events AppKit hands it, with a made-up live
// file in place of a recording (so the test decides what the hand "sees"). Checks: play lands and keeps moving; a pop
// (the screen jumping when the fingers did nothing new) is noticed and crossed again; the fingers lift when the eye
// goes blind; SIGUSR1 (what the server sends on Esc ×6) stops play, and steps are refused until "fresh"; a recorded
// touch that ended at speed is thrown (momentum) and one that stopped is not; Natural scrolling off turns the events
// round. Holds the eye's input lock for the whole run (3·2·1 first; Esc ×6 releases it), about 25s.
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { parseWing } from "../src/wing.ts";

const root = new URL("..", import.meta.url).pathname;
const tmp = "/tmp/the-eye-test";
mkdirSync(tmp, { recursive: true });
const gt = `${tmp}/gesture-target`;
const b = spawnSync("swiftc", ["-O", `${root}test/gesture-target.swift`, "-o", gt], { encoding: "utf8" });
if (b.status !== 0) { console.error(b.stderr); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name, ok, detail) => { console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail !== undefined ? ` — ${detail}` : ""}`); if (!ok) failed++; };

// The lock first: the panel is put under the pointer, which must not move after that.
const lock = spawn(`${root}bin/eye-capture`, ["lock", "--seconds", "60", "--allow", "tagged"], { stdio: ["ignore", "pipe", "pipe"] });
await new Promise((res, rej) => {
  let err = "";
  lock.stderr.on("data", (d) => { err += d; if (err.includes("locked for")) res(); });
  lock.on("close", () => rej(new Error(`lock failed: ${err}`)));
});

// A panel under the pointer: the pointer is not moved and no app loses focus.
const target = spawn(gt, ["--at-pointer"]);
const seen = [];
let ready;
const up = new Promise((r) => (ready = r));
createInterface({ input: target.stdout }).on("line", (l) => {
  const o = JSON.parse(l);
  if (o.kind === "ready") ready(o); else if (o.kind === "scroll") seen.push({ ...o, at: performance.now() });
});
const win = await up;

function actorOf(args = []) {
  const p = spawn(`${root}bin/eye-capture`, ["input", ...args]);
  const replies = createInterface({ input: p.stdout })[Symbol.asyncIterator]();
  return { p, send: async (cmd) => { p.stdin.write(JSON.stringify(cmd) + "\n"); return JSON.parse((await replies.next()).value); } };
}
const actor = actorOf(["-com.apple.swipescrolldirection", "YES"]);   // whatever the system setting is
{
  const o = await actor.send({ op: "owner" });
  if (o.pid !== win.pid) { console.error(`the panel is not under the pointer (${o.owner} is): nothing was sent`); target.kill(); lock.kill("SIGTERM"); process.exit(1); }
  // A window that appears under a pointer at rest gets no scrolls until the pointer has moved: one point and back.
  const at = await actor.send({ op: "pos" });
  await actor.send({ op: "move", x: at.x + 1, y: at.y, ms: 0 });
  await actor.send({ op: "move", x: at.x, y: at.y, ms: 0 });
  await sleep(200);
}

// The made-up live file: 50ms bins of a screen that changes a little all the time, on the helper's clock.
const live = `${tmp}/hand-live.json`;
const eye = { offset: 0, bins: [], error: null, pop: false, on: true };
{
  let best = Infinity;
  for (let i = 0; i < 5; i++) {
    const a = performance.now(), r = await actor.send({ op: "wing", moves: [] }), dt = performance.now() - a;
    if (dt < best) { best = dt; eye.offset = r.t0 - a / 1000; }
  }
}
const writer = setInterval(() => {
  if (!eye.on) return;
  const v = eye.pop ? 0.6 : 0.004;
  eye.pop = false;
  eye.bins.push([performance.now() / 1000 + eye.offset, v, v, 0, 0, 100, 100, 100, 100]);
  eye.bins = eye.bins.slice(-24);
  const o = { frames_total: 100, moving: true, t0_mach: 0, motion: eye.bins, ...(eye.error ? { stream_error: eye.error } : {}) };
  writeFileSync(live + ".tmp", JSON.stringify(o));
  renameSync(live + ".tmp", live);
}, 50);
await sleep(200);

const wing = (a, words, extra = {}) => {
  const w = parseWing(words);
  if (w.error) throw new Error(w.error);
  return a.send({ op: "wing", moves: w.moves, pid: win.pid, require_pid: win.pid, bounds: [win.x, win.y, win.w, win.h], live, hold_ms: 6000, ...extra });
};
// NSEvent.Phase: began 1, changed 4, ended 8.
const since = (n) => seen.slice(n);
const sum = (ev) => ev.reduce((s, e) => s + e.dy, 0);
const quietFor = async (ms) => { const n = seen.length; await sleep(ms); return seen.length - n; };

try {
  // ---- play
  let n = seen.length;
  let r = await wing(actor, "fingers play lively 50 rest 2500", { fresh: true });
  let ev = since(n);
  check("play: the fingers land by themselves and keep moving", r.ok && r.playing === "lively" && ev.some((e) => e.phase === 1) && ev.filter((e) => e.phase === 4).length > 30,
    `${ev.length} scroll events, playing ${r.playing}, ${(r.plots ?? []).length} plots`);
  const kinds = (r.plots ?? []).map((p) => p.k);
  check("play: it says what they did", kinds.length >= 3, [...new Set(kinds)].join(" "));

  // ---- a pop, while the fingers are down
  let pop = null;
  for (let tries = 0; tries < 4 && !pop; tries++) {
    const armed = (async () => {
      for (let i = 0; i < 60; i++) {
        await sleep(25);
        const l = seen.at(-1);
        if (i > 8 && l && l.phase === 4 && performance.now() - l.at < 30) { eye.pop = true; return; }
      }
    })();
    r = await wing(actor, "rest 2600");
    await armed;
    const pl = r.plots ?? [], at = pl.findIndex((p) => p.k === "pop");
    if (at >= 0) pop = { pl, at };
    else if (!r.playing) r = await wing(actor, "fingers play lively 50 rest 600");
  }
  check("pop: the screen jumping under still-ish fingers is noticed", !!pop, pop ? `at ${pop.pl[pop.at].x.toFixed(0)},${pop.pl[pop.at].y.toFixed(0)}` : "no pop in 4 tries");
  if (pop) {
    const after = pop.pl.slice(pop.at + 1).map((p) => p.k);
    check("pop: they go back over that place", after.includes("cross"), after.join(" "));
  }

  // ---- the eye goes blind
  r = await wing(actor, "fingers play lively 50 rest 800");
  n = seen.length;
  eye.error = "made up";
  await sleep(500);
  ev = since(n);
  const stillComing = await quietFor(500);
  check("blind: the fingers lift and nothing more is sent", (ev.some((e) => e.phase === 8) || !ev.length) && stillComing === 0, `${ev.length} events then ${stillComing}`);
  r = await wing(actor, "rest 100");
  check("blind: the reply says so", /blind/.test(String(r.stopped)) && !!r.blind && !r.fingers, String(r.stopped));
  eye.error = null;
  await sleep(200);

  // ---- Esc ×6, as the server tells the hand
  r = await wing(actor, "fingers play wild 60 rest 800", { fresh: true });
  check("play again after the eye is back", r.ok && !!r.playing && !r.stopped, String(r.stopped ?? r.playing));
  // Play lifts now and then to watch: a reply that comes just then says the fingers are up, not down.
  let up = null;
  for (let i = 0; i < 60 && !up; i++) { r = await wing(actor, "rest 120"); if (r.lifted) up = r; }
  check("play: a reply while they are up to watch says lifted", !!up && up.fingers === true && /lifted/.test(String(up.doing)), up ? up.doing : "never lifted in 7s");
  if (!r.playing) r = await wing(actor, "fingers play wild 60 rest 600");
  for (let i = 0; i < 30 && r.lifted; i++) r = await wing(actor, "rest 120");
  n = seen.length;
  actor.p.kill("SIGUSR1");
  await sleep(250);
  ev = since(n);
  const afterTaken = await quietFor(600);
  check("taken: play stops and the fingers lift at once", ev.some((e) => e.phase === 8) && afterTaken === 0, `${ev.length} events then ${afterTaken}`);
  const pos = await actor.send({ op: "pos" });
  r = await actor.send({ op: "move", x: pos.x + 3, y: pos.y, ms: 0 });
  check("taken: a step is refused", r.ok === false && r.taken === true, r.error);
  r = await actor.send({ op: "scroll", dy: -5, events: 10, require_pid: win.pid });
  check("taken: a scroll step is refused", r.ok === false && r.taken === true && (await quietFor(150)) === 0, r.error);
  r = await wing(actor, "fingers 0,40 lift");
  check("taken: a wing is refused", /took their input back/.test(String(r.stopped)) && r.taken === true, String(r.stopped));
  r = await actor.send({ op: "fresh" });
  r = await actor.send({ op: "move", x: pos.x, y: pos.y, ms: 0 });
  check("fresh: a new session's steps run again", r.ok === true, r.error);

  // ---- a recorded touch, thrown and not
  const traced = async (trace) => {
    const from = seen.length;
    const rr = await actor.send({ op: "wing", moves: [{ k: "fingers", like: "x", trace }, { k: "rest", ms: 700 }], pid: win.pid, require_pid: win.pid, bounds: [win.x, win.y, win.w, win.h], live, hold_ms: 3000 });
    return { rr, ev: since(from) };
  };
  let t = await traced([[0, 0, 0], [0.08, 0, -20], [0.16, 0, -70], [0.22, 0, -150], [0.26, 0, -230]]);
  let touch = t.ev.filter((e) => e.phase !== 0), mom = t.ev.filter((e) => e.momentum !== 0);
  check("a recorded touch that ended at speed is thrown: momentum follows the lift", touch.some((e) => e.phase === 8) && mom.length > 5 && Math.sign(sum(mom)) === Math.sign(sum(touch)) && !t.rr.fingers,
    `touch ${sum(touch).toFixed(0)} then momentum ${sum(mom).toFixed(0)} in ${mom.length} events`);
  t = await traced([[0, 0, 0], [0.1, 0, -60], [0.2, 0, -110], [0.3, 0, -120], [0.4, 0, -120]]);
  mom = t.ev.filter((e) => e.momentum !== 0);
  check("one that came to a stop is not: the fingers stay down", mom.length === 0 && t.rr.fingers === true && !t.rr.lifted, `${mom.length} momentum events`);
  await wing(actor, "lift");

  // ---- Natural scrolling off (for that helper only)
  n = seen.length;
  await wing(actor, "fingers down 60 lift");
  const nat = since(n);
  const other = actorOf(["-com.apple.swipescrolldirection", "NO"]);
  n = seen.length;
  r = await wing(other, "fingers down 60 lift", { fresh: true });
  const un = since(n);
  other.p.stdin.end();
  check("Natural scrolling on: the events say so", nat.length > 3 && nat.every((e) => e.inv === true), `dy ${sum(nat).toFixed(0)}`);
  check("Natural scrolling off: the same fingers scroll the other way, and the events say so",
    un.length > 3 && un.every((e) => e.inv === false) && Math.sign(sum(un)) === -Math.sign(sum(nat)) && r.natural === false, `dy ${sum(un).toFixed(0)}`);
} finally {
  clearInterval(writer);
  try { await actor.send({ op: "wing", moves: [], end: true }); } catch { /* gone */ }
  actor.p.stdin.end();
  target.kill();
  lock.kill("SIGTERM");
}
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
