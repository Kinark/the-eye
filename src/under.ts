// Under the pixels: who was late, where the time went, and what the motion cost.
//
// A recording shows a frame arriving late; it cannot show whose fault that was. The system can, from five places.
// Two need no root and run with every recording of an app:
//   signposts    what AppKit, Core Animation and the window server say about themselves (`log stream --signpost`):
//                each update cycle of the app, each event it handled, each commit, the ones the frameworks flag as
//                stalls; each frame of the window server, how long it rendered, and the ones IT flags      → signs.txt
//   vitals       energy, CPU time and wakeups billed to the app (proc_pid_rusage), the window server's update
//                count and the display's refresh period (SkyLight, private), twenty times a second    → vitals.jsonl
// Two need root (the-eye never asks for a password: it uses them only when `sudo -n` already allows it):
//   dtrace       the app's Core Animation commits, the window server's frame swaps, and each time the window
//                server learned that one of THIS APP's windows changed and scheduled a frame for it     → under.txt
//   powermetrics CPU time of the app and of the window server, and GPU and CPU power, ten times a second → cost.jsonl
// dtrace and the vitals are stamped on the wall clock, signposts on the mach clock: both are the recording's own.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DTRACE = "/usr/sbin/dtrace", POWERMETRICS = "/usr/bin/powermetrics", LOG = "/usr/bin/log";
const allowed = new Map<string, boolean>();
/** True when sudo runs this tool without asking (a sudoers NOPASSWD rule, or root). Asked once per tool. */
export function rootAllows(tool: string): boolean {
  if (!allowed.has(tool)) {
    const r = spawnSync("/usr/bin/sudo", ["-n", "-l", tool], { stdio: "ignore", timeout: 3000 });
    allowed.set(tool, r.status === 0);
  }
  return allowed.get(tool)!;
}
/** What to tell someone whose recordings have no root readings. */
export const ROOT_HINT = `the root readings (this app's own share of the display's frames, GPU power) need dtrace and powermetrics without a password: add "${process.env.USER ?? "you"} ALL=(root) NOPASSWD: ${DTRACE}, ${POWERMETRICS}" to /etc/sudoers.d/the-eye (sudo visudo -f /etc/sudoers.d/the-eye)`;

let ticks = 0;
/** Mach ticks per second (24 000 000 on Apple silicon, 1e9 on Intel). */
function ticksPerSecond(): number {
  if (!ticks) ticks = Number(spawnSync("/usr/sbin/sysctl", ["-n", "hw.tbfrequency"], { encoding: "utf8", timeout: 2000 }).stdout) || 24e6;
  return ticks;
}

/** `held` run as root and end when their pipe closes; `own` are ours and end on a signal. */
export type Under = { held: ChildProcess[]; own: ChildProcess[]; heard: { at: number } };

/**
 * One signpost → one line of signs.txt, all times in mach ticks:
 *   U begin end stall   an AppKit update cycle        E begin end   an event handled inside one
 *   C begin end stall   a Core Animation commit       I begin end   idle work after one
 *   F base life render gpu stall   a window server frame: when it began, ticks until it was on the glass,
 *                                  ticks spent rendering and on the GPU, and whether the server called it stalled
 */
function signLine(o: any, open: Map<string, number>): string | undefined {
  const name = o.signpostName, at = Number(o.machTimestamp), msg: string = o.eventMessage ?? "";
  if (!name || !at) return undefined;
  const stall = /\.stalls$/i.test(o.category ?? "") ? 1 : 0;
  if (name === "FrameUpdate") {
    const f = (k: string) => BigInt(msg.match(new RegExp(`${k}=(\\d+)`))?.[1] ?? "0");
    // Two 32-bit offsets from base_mct packed in one number: the end in the low half, the beginning in the high.
    const span = (v: bigint) => Math.max(0, Number(v & 0xffffffffn) - Number(v >> 32n));
    const base = f("base_mct");
    return base ? `F ${base} ${span(f("FrameLifetimeInterval"))} ${span(f("FrameRender"))} ${span(f("FrameGPUExecute"))} ${stall}` : undefined;
  }
  const began = Number(msg.match(/begin_time#_##_#(\d+)/)?.[1]);
  if (name === "UpdateSequence" && began) return `U ${began} ${at} ${stall}`;
  if (name === "Commit" && o.subsystem === "com.apple.coreanimation" && began) return `C ${began} ${at} ${stall}`;
  if (name === "EventDispatch" || name === "IdleWork") {
    if (o.signpostType === "begin") { open.set(name, at); return undefined; }
    const b = open.get(name);
    open.delete(name);
    return b ? `${name[0]} ${b} ${at}` : undefined;
  }
  return undefined;
}

/**
 * Starts what can be read under a recording of `pid`. `root:false` (or THE_EYE_ROOT=0) leaves out dtrace and
 * powermetrics; THE_EYE_UNDER=0 leaves out everything (to measure what the readings themselves cost).
 */
export function startUnder(dir: string, pid: number, seconds: number, o: { root?: boolean; helper?: string } = {}): Under | null {
  if (process.env.THE_EYE_UNDER === "0") return null;
  const u: Under = { held: [], own: [], heard: { at: 0 } };
  const limit = Math.ceil(seconds), asRoot = o.root !== false && process.env.THE_EYE_ROOT !== "0";
  const quiet = (c: ChildProcess) => { c.on("error", () => {}); return c; };
  try {
    const out = join(dir, "signs.txt");
    appendFileSync(out, `T ${ticksPerSecond()}\n`);
    const pred = `(processID == ${pid} AND (subsystem == "com.apple.AppKit" OR subsystem == "com.apple.coreanimation")) OR (process == "WindowServer" AND subsystem == "com.apple.SkyLight" AND category BEGINSWITH "tracing")`;
    const c = quiet(spawn(LOG, ["stream", "--signpost", "--style", "ndjson", "--predicate", pred, "--timeout", `${limit}s`], { stdio: ["ignore", "pipe", "ignore"] }));
    const open = new Map<string, number>();
    let buf = "";
    c.stdout!.on("data", (chunk) => {
      buf += chunk;
      u.heard.at = Date.now();
      let i: number, lines = "";
      while ((i = buf.indexOf("\n")) >= 0) {
        const l = buf.slice(0, i); buf = buf.slice(i + 1);
        if (l[0] !== "{") continue;
        try { const s = signLine(JSON.parse(l), open); if (s) lines += s + "\n"; } catch { /* a torn line */ }
      }
      if (lines) try { appendFileSync(out, lines); } catch { /* run folder gone */ }
    });
    u.own.push(c);
  } catch { /* a recording without signposts is still a recording */ }
  try {
    if (o.helper) u.own.push(quiet(spawn(o.helper, ["vitals", "--pid", String(pid), "--out", join(dir, "vitals.jsonl"), "--seconds", String(limit)], { stdio: "ignore" })));
  } catch { /* nor without vitals */ }
  try {
    if (asRoot && rootAllows(DTRACE)) {
      const ws = spawnSync("/usr/bin/pgrep", ["-x", "WindowServer"], { encoding: "utf8", timeout: 2000 }).stdout.trim().split("\n")[0];
      // A render context of the window server carries its client's audit token (pid at +0xe0) and its id (+0x10).
      // If a later macOS moves them no X line matches the app, and the report says nothing about its share.
      const d = [
        `pid${pid}:QuartzCore:CA??Transaction??commit():entry { self->c = timestamp; }`,
        `pid${pid}:QuartzCore:CA??Transaction??commit():return /self->c/ { printf("C %d %d\\n", walltimestamp, timestamp - self->c); self->c = 0; }`,
        ...(ws ? [
          `pid${ws}:QuartzCore:CA??WindowServer??IOMFBDisplay??swap_set_layer*:entry { printf("S %d %x\\n", walltimestamp, arg0); }`,
          `pid${ws}:QuartzCore:CA??Render??Context??did_commit*:entry { this->p = *(int *)copyin(arg0 + 0xe0, 4); this->c = *(uint32_t *)copyin(arg0 + 0x10, 4); }`,
          `pid${ws}:QuartzCore:CA??Render??Context??did_commit*:entry /this->p == ${pid} && !seen[this->c]/ { seen[this->c] = 1; printf("X %x\\n", this->c); }`,
          `pid${ws}:SkyLight:WSScheduleUpdateForCAContextChange:entry { printf("W %d %x\\n", walltimestamp, arg1); }`,
        ] : []),
        `tick-${limit}s { exit(0); }`,
      ].join(" ");
      // -Z: a probe this macOS does not have is left out instead of failing the whole script.
      const c = quiet(spawn("/usr/bin/sudo", ["-n", DTRACE, "-Z", "-q", "-x", "switchrate=20hz", "-o", join(dir, "under.txt"), "-c", "/bin/cat", "-n", d], { stdio: ["pipe", "ignore", "ignore"] }));
      c.stdin!.on("error", () => {});
      u.held.push(c);
    }
    if (asRoot && rootAllows(POWERMETRICS)) {
      const out = join(dir, "cost.jsonl");
      const c = quiet(spawn("/usr/bin/sudo", ["-n", POWERMETRICS, "--samplers", "tasks,gpu_power,cpu_power", "--show-process-gpu", "-i", "100", "-n", String(limit * 10), "-b", "1"],
        { stdio: ["ignore", "pipe", "ignore"] }));
      // powermetrics stamps its samples to the second; the moment a sample's header arrives is good to a few ms.
      let buf = "", cur: any = null;
      const task = /\s(\d+)\s+([\d.]+)\s+[\d.]+\s+[\d.]+\s+[\d.]+\s+[\d.]+\s+[\d.]+\s+([\d.]+)\s*$/;
      const flush = () => { if (cur) try { appendFileSync(out, JSON.stringify(cur) + "\n"); } catch { /* run folder gone */ } cur = null; };
      c.stdout!.on("data", (chunk) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const l = buf.slice(0, i); buf = buf.slice(i + 1);
          const head = l.match(/^\*\*\* Sampled system activity .*\(([\d.]+)ms elapsed\)/);
          if (head) { flush(); cur = { t: (performance.timeOrigin + performance.now()) / 1000, ms: Number(head[1]) }; continue; }
          if (!cur) continue;
          const m = l.match(task);
          if (m && Number(m[1]) === pid) { cur.app_cpu = Number(m[2]); cur.app_gpu = Number(m[3]); }
          else if (m && l.startsWith("WindowServer ")) { cur.ws_cpu = Number(m[2]); cur.ws_gpu = Number(m[3]); }
          else if (l.startsWith("GPU Power:")) cur.gpu_mw = Number(l.match(/([\d.]+) mW/)?.[1]);
          else if (l.startsWith("CPU Power:")) cur.cpu_mw = Number(l.match(/([\d.]+) mW/)?.[1]);
        }
      });
      c.on("close", flush);
      u.held.push(c);
    }
  } catch { /* a recording without root readings is still a recording */ }
  return u.held.length || u.own.length ? u : null;
}

/**
 * Ends every reader. The root ones cannot be signalled from here; each is held by a pipe instead: dtrace lives as
 * long as the `cat` it was started with (`-c`), which lives as long as its stdin, and powermetrics dies writing to
 * a closed stdout. The same pipes end them if this process dies; the others carry their own time limit.
 */
export function endUnder(u: Under | null | undefined) {
  for (const c of u?.held ?? []) { c.stdin?.end(); c.stdout?.destroy(); }
  for (const c of u?.own ?? []) c.kill("SIGTERM");
}
/** Ends them and waits: for the last signposts to arrive (they trail by a millisecond or so), and for dtrace to write what it buffered. */
export async function stopUnder(u: Under | null | undefined): Promise<void> {
  if (!u) return;
  for (let i = 0; i < 8 && Date.now() - u.heard.at < 120; i++) await new Promise((r) => setTimeout(r, 40));
  await Promise.all([...u.held, ...u.own].map((c) => new Promise<void>((res) => {
    if (c.exitCode !== null || c.signalCode !== null) return res();
    const t = setTimeout(res, 2500);
    c.once("close", () => { clearTimeout(t); res(); });
    endUnder({ held: u.held.includes(c) ? [c] : [], own: u.own.includes(c) ? [c] : [], heard: u.heard });
  })));
}

type Cost = { t: number; ms: number; app_cpu?: number; app_gpu?: number; ws_cpu?: number; ws_gpu?: number; gpu_mw?: number; cpu_mw?: number };
type Span = { t: number; ms: number; stall?: boolean };
/** What the app was billed between two vitals ticks (`t` is the later one, `s` the seconds between them). */
type Vital = { t: number; s: number; mj: number; pmj: number; cpu: number; wk: number; upd?: number; vbl?: number };
export type Readings = {
  /** The app's Core Animation commits: when each ended (run clock, s) and how long it ran (ms). */
  commits: Span[];
  /** When the window server handed a new frame to the display (run clock, s), busiest display. */
  swaps: number[];
  /** When the window server learned that a window of THIS app changed, and scheduled a frame (root only). */
  changes?: number[];
  cost: Cost[];
  /** AppKit update cycles of the app, the events handled in them, and what the frameworks flagged as stalls. */
  cycles: Span[]; events: Span[]; stalledCommits: Span[];
  /** Window server frames: when each began, ms until it was on the glass, ms rendering, ms on the GPU. */
  frames: { t: number; life: number; render: number; gpu: number; stall: boolean }[];
  vitals: Vital[];
  by: { root: string[]; own: string[] };
};

export function loadUnder(dir: string, t0Wall: number, t0Mach = 0): Readings | null {
  if (!t0Wall) return null;
  const r: Readings = { commits: [], swaps: [], cost: [], cycles: [], events: [], stalledCommits: [], frames: [], vitals: [], by: { root: [], own: [] } };
  const file = (name: string) => { const p = join(dir, name); return existsSync(p) ? readFileSync(p, "utf8").split("\n") : []; };

  const byDisplay = new Map<string, number[]>(), mine = new Set<string>(), changed: [number, string][] = [];
  for (const l of file("under.txt")) {
    const p = l.split(" ");
    if (p[0] === "C" && p.length === 3) r.commits.push({ t: Number(p[1]) / 1e9 - t0Wall, ms: Number(p[2]) / 1e6 });
    else if (p[0] === "S" && p.length === 3) {
      const t = Number(p[1]) / 1e9 - t0Wall, list = byDisplay.get(p[2]) ?? [];
      // One frame can set several layers within a millisecond or two: that is one swap.
      if (!list.length || t - list[list.length - 1] > 0.003) list.push(t);
      byDisplay.set(p[2], list);
    } else if (p[0] === "X" && p.length === 2) mine.add(p[1]);
    else if (p[0] === "W" && p.length === 3) changed.push([Number(p[1]) / 1e9 - t0Wall, p[2]]);
  }
  r.swaps = [...byDisplay.values()].sort((a, b) => b.length - a.length)[0] ?? [];
  // Only when the app's contexts were recognised: otherwise "no change reached the window server" would be a guess.
  if (mine.size) r.changes = changed.filter(([, ctx]) => mine.has(ctx)).map(([t]) => t).sort((a, b) => a - b);
  if (r.commits.length || r.swaps.length) r.by.root.push("dtrace");

  for (const l of file("cost.jsonl")) {
    if (!l) continue;
    try { const o = JSON.parse(l); r.cost.push({ ...o, t: o.t - t0Wall }); } catch { /* torn line */ }
  }
  if (r.cost.length) r.by.root.push("powermetrics");

  if (t0Mach) {
    let tps = 24e6;
    const signed: Span[] = [];
    for (const l of file("signs.txt")) {
      const p = l.split(" "), n = p.slice(1).map(Number);
      const at = (k: number) => n[k] / tps - t0Mach, span = (stall?: number): Span => ({ t: at(1), ms: ((n[1] - n[0]) / tps) * 1000, stall: stall === 1 });
      if (p[0] === "T" && n[0] > 0) tps = n[0];
      else if (p[0] === "U" && p.length === 4) r.cycles.push(span(n[2]));
      else if (p[0] === "E" && p.length === 3) r.events.push(span());
      else if (p[0] === "C" && p.length === 4) { const c = span(n[2]); signed.push(c); if (c.stall) r.stalledCommits.push(c); }
      else if (p[0] === "F" && p.length === 6) r.frames.push({ t: at(0), life: (n[1] / tps) * 1000, render: (n[2] / tps) * 1000, gpu: (n[3] / tps) * 1000, stall: n[4] === 1 });
    }
    r.frames.sort((a, b) => a.t - b.t);
    if (r.cycles.length || signed.length || r.frames.length) r.by.own.push("signposts");
    // Without root the same two facts come from the signposts: the app's commits, and the window server's frames.
    if (!r.commits.length) r.commits = signed;
    if (!r.swaps.length) r.swaps = r.frames.map((f) => f.t);
  }
  r.commits.sort((a, b) => a.t - b.t);

  let prev: any = null;
  for (const l of file("vitals.jsonl")) {
    if (!l) continue;
    let o: any;
    try { o = JSON.parse(l); } catch { continue; }
    if (prev && o.t > prev.t) r.vitals.push({ t: o.t - t0Wall, s: o.t - prev.t, mj: (o.nj - prev.nj) / 1e6, pmj: (o.pnj - prev.pnj) / 1e6, cpu: o.cpu - prev.cpu, wk: o.wk - prev.wk,
      upd: typeof o.upd === "number" && typeof prev.upd === "number" ? o.upd - prev.upd : undefined, vbl: o.vbl });
    prev = o;
  }
  if (r.vitals.length) { r.by.own.push("rusage"); if (r.vitals.some((v) => v.upd !== undefined || v.vbl)) r.by.own.push("SkyLight"); }
  return r.by.root.length || r.by.own.length ? r : null;
}

/** The heading of the section: which readers the lines under it come from. */
export function underTitle(u: Readings): string {
  return `under the pixels (${[u.by.root.length ? `as root: ${u.by.root.join(", ")}` : "", u.by.own.length ? `${u.by.root.length ? "no root: " : ""}${u.by.own.join(", ")}` : ""].filter(Boolean).join(" · ")}):`;
}

const ms = (x: number) => `${x >= 100 ? x.toFixed(0) : x.toFixed(1)}ms`;
const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN);
const sum = (v: number[]) => v.reduce((a, b) => a + b, 0);
const median = (v: number[]) => (v.length ? [...v].sort((a, b) => a - b)[v.length >> 1] : NaN);
const r0 = (x: number) => (Number.isFinite(x) ? String(Math.round(x)) : "?");
const times = (n: number) => (n === 1 ? "once" : `${n}×`);

/** Each change of the app's windows paired with the display frame that followed it: how many frames, how long each waited (ms). */
function carried(changes: number[], swaps: number[]): { frames: number; waits: number[] } {
  const seen = new Set<number>(), waits: number[] = [];
  let k = 0;
  for (const t of changes) {
    while (k < swaps.length && swaps[k] < t) k++;
    if (k < swaps.length) { seen.add(k); waits.push((swaps[k] - t) * 1000); }
  }
  return { frames: seen.size, waits };
}

/**
 * What a frame the window server marked as stalled was doing. Its mark means "long from scheduled to on the glass",
 * which is as often a wait for a client as slow work of its own: the time it spent rendering tells the two apart.
 */
function stalledHow(stalled: Readings["frames"], periodMs: number): string {
  const worst = stalled.reduce((a, b) => (b.life > a.life ? b : a));
  return `${ms(worst.life)} from scheduled to on the glass, ${ms(worst.render)} of it rendering: ${worst.render < periodMs ? "it was waiting, not working" : "its own rendering was slow"}`;
}

/** Where a late update cycle spent its time, by AppKit's own signposts. */
function insideTheApp(u: Readings, from: number, to: number, least: number): string {
  const c = u.cycles.filter((x) => x.t > from && x.t - x.ms / 1000 < to).sort((a, b) => b.ms - a.ms)[0];
  if (!c || c.ms < least) return "";
  const b = c.t - c.ms / 1000, within = (v: Span[]) => sum(v.filter((x) => x.t <= c.t + 1e-4 && x.t - x.ms / 1000 >= b - 1e-4).map((x) => x.ms));
  const ev = within(u.events), co = within(u.commits);
  const where = ev >= 0.5 * c.ms ? `${ms(ev)} of it handling an event (the app's own handler)`
    : co >= 0.5 * c.ms ? `${ms(co)} of it in the commit (layout, drawing and sending the layer tree)`
    : `${ev + co < 1 ? "none" : ms(ev + co)} of it handling an event or committing, so it went to the app's own per-frame code (a display link or timer callback, layout, drawing)`;
  return `; AppKit's update cycle ran ${ms(c.ms)}${c.stall ? " and AppKit flagged it a stall" : ""}: ${where} (signposts)`;
}

/**
 * Who was late in a stretch where the screen stood still (run clock, seconds), from the commits and swaps.
 * Returns undefined when the readings do not cover it.
 */
export function whoWasLate(u: Readings, from: number, to: number, periodMs: number): string | undefined {
  const first = Math.min(u.swaps[0] ?? Infinity, u.commits[0]?.t ?? Infinity), last = Math.max(u.swaps[u.swaps.length - 1] ?? -Infinity, u.commits[u.commits.length - 1]?.t ?? -Infinity);
  if (!(first <= from && last >= to)) return undefined;
  const by = u.by.root.includes("dtrace") ? "dtrace" : "signposts";
  const period = periodMs / 1000, len = to - from;
  // The frame shown at `to` was committed a refresh or two before it: look that far back, and no further ahead.
  const co = u.commits.filter((c) => c.t > from - 3 * period && c.t < to + period);
  const sw = u.swaps.filter((t) => t > from - period && t < to + period);
  let quiet = 0, after: Span | undefined;
  for (let i = 1; i < co.length; i++) if (co[i].t - co[i - 1].t > quiet) { quiet = co[i].t - co[i - 1].t; after = co[i]; }
  let gap = sw.length ? 0 : len;
  for (let i = 1; i < sw.length; i++) gap = Math.max(gap, sw[i] - sw[i - 1]);
  const inside = insideTheApp(u, from - 3 * period, to + period, 0.5 * len * 1000);
  // What the window server says of its own frames here.
  const stalled = u.frames.filter((f) => f.stall && f.t > from - period && f.t < to + period);
  const server = stalled.length ? `; the window server marked ${stalled.length === 1 ? "one of its frames" : `${stalled.length} of its frames`} here as stalled (${stalledHow(stalled, periodMs)})` : "";
  if (!u.commits.length) return gap > 1.5 * period ? `the window server was late: no frame went to the display for ${ms(gap * 1000)} (${by})${server}` : undefined;
  if (co.length < 2) return `the app was late: it committed ${co.length ? "once" : "nothing"} to Core Animation around these ${ms(len * 1000)} (${by})${inside}`;
  if (quiet >= 0.7 * len) return `the app was late: it committed nothing to Core Animation for ${ms(quiet * 1000)}${after && after.ms > periodMs ? `, and the commit that ended the silence took ${ms(after.ms)}` : ""} (${by})${inside}`;
  const kept = `the app kept committing (${co.length}×, never more than ${ms(quiet * 1000)} apart)`;
  if (gap > 1.5 * period) return `the window server was late: ${kept} but no frame went to the display for ${ms(gap * 1000)} (${by})${server}`;
  // The display's frames are everyone's. Whether THIS app's changes were among them is read from the window server itself.
  const ch = u.changes?.filter((t) => t > from - 3 * period && t < to);
  if (ch && !ch.length) return `${kept} but no change of its windows reached the window server (dtrace): what it committed was the same picture`;
  if (ch) {
    const { frames, waits } = carried(ch, u.swaps), worst = Math.max(...waits, 0);
    if (worst > 2.5 * periodMs) return `the window server was late for this app: ${kept}, the window server learned of a change to its windows and took ${ms(worst)} to put a frame on the display (dtrace)${server}`;
    return `${kept} and the window server put each change of its windows on the display (${frames} frames, never more than ${ms(worst)} after it learned of one; dtrace): the frames were on time, what they drew here did not change`;
  }
  return `${kept} and the display kept getting frames (${by}): its commits did not change this region, or the window server did not show them`;
}

/** The readings told against the motions: commits and frames while moving, where the app's time went, and what moving cost. */
export function underLines(u: Readings, segs: { start_s: number; end_s: number }[], periodMs: number): string[] {
  const L: string[] = [];
  const name = (i: number) => (segs.length > 1 ? `motion ${i + 1}` : "the motion");
  const inSeg = (t: number) => segs.some((s) => t >= s.start_s && t <= s.end_s);
  const pad = periodMs / 1000;
  segs.slice(0, 6).forEach((s, i) => {
    const dur = Math.max(1e-3, s.end_s - s.start_s), parts: string[] = [], more: string[] = [];
    const within = <T extends { t: number }>(v: T[]) => v.filter((x) => x.t >= s.start_s && x.t <= s.end_s + pad);
    const co = within(u.commits);
    const sw = u.swaps.filter((t) => t >= s.start_s && t <= s.end_s + pad);
    const driven = co.length / dur >= 10;
    if (u.commits.length || u.swaps.length) {
      const long = co.reduce((m, c) => Math.max(m, c.ms), 0);
      const handed = "the window server ran the motion on its own (a Core Animation animation: no per-frame work in the app)";
      parts.push(!co.length ? `the app committed nothing: ${handed}`
        : !driven ? `the app committed ${times(co.length)} (longest ${ms(long)} on its main thread), then ${handed}`
        : `the app committed ${co.length}× (${r0(co.length / dur)}/s, longest ${ms(long)} on its main thread): it drives the motion frame by frame`);
    }
    if (u.swaps.length) {
      let gap = 0;
      for (let k = 1; k < sw.length; k++) gap = Math.max(gap, sw[k] - sw[k - 1]);
      const rate = sw.length > 1 ? (sw.length - 1) / (sw[sw.length - 1] - sw[0]) : NaN;
      parts.push(`the display got ${sw.length} frames${sw.length > 1 ? ` (${r0(rate)}/s, longest wait ${ms(gap * 1000)})` : ""}`);
    }
    // Which of the display's frames were this app's: each change of its windows, and the frame that followed it.
    const ch = u.changes?.filter((t) => t >= s.start_s - pad && t <= s.end_s);
    if (ch?.length && driven) {
      const { frames, waits } = carried(ch, u.swaps);
      if (waits.length) more.push(`this app's share: ${frames} of those frames carried a change of its windows, each on the display ${ms(median(waits))} after the window server learned of it (worst ${ms(Math.max(...waits))})`);
    } else if (ch && driven) more.push(`this app's share: none of those frames carried a change of its windows (its commits changed nothing the window server draws)`);
    else if (u.changes && sw.length && (u.commits.length || u.swaps.length)) more.push(`this app's share: all of those frames (the window server redraws a running animation in every frame it makes)`);
    // Inside the app, by AppKit's and Core Animation's own account.
    const cy = within(u.cycles);
    if (cy.length && driven) {
      const flagged = cy.filter((c) => c.stall), ev = within(u.events), slow = within(u.stalledCommits);
      more.push(`inside the app: ${cy.length} AppKit update cycles (median ${ms(median(cy.map((c) => c.ms)))}, longest ${ms(Math.max(...cy.map((c) => c.ms)))})`
        + `${flagged.length ? `, ${flagged.length} of them flagged as ${flagged.length === 1 ? "a stall" : "stalls"} by AppKit` : ", none flagged as a stall"}`
        + `${slow.length ? ` · Core Animation flagged ${slow.length === 1 ? "one commit" : `${slow.length} commits`} as stalled (longest ${ms(Math.max(...slow.map((c) => c.ms)))})` : ""}`
        + `${ev.length ? ` · ${ev.length} events handled (longest ${ms(Math.max(...ev.map((e) => e.ms)))})` : ""}`);
    }
    const fr = within(u.frames);
    if (fr.length) {
      const st = fr.filter((f) => f.stall);
      more.push(`the window server: rendered each frame in ${ms(median(fr.map((f) => f.render)))} (longest ${ms(Math.max(...fr.map((f) => f.render)))}), ${ms(median(fr.map((f) => f.gpu)))} of GPU work`
        + `${st.length ? `; it marked ${st.length} of ${fr.length} as stalled (${stalledHow(st, periodMs)})` : `; it marked none of ${fr.length} as stalled`}`);
    }
    // SkyLight's own counter checks the stream: signposts are best-effort, a count is not.
    const vi = u.vitals.filter((v) => v.t - v.s >= s.start_s && v.t <= s.end_s);
    const counted = sum(vi.map((v) => v.upd ?? 0)), heard = u.frames.filter((f) => vi.length && f.t >= vi[0].t - vi[0].s && f.t <= vi[vi.length - 1].t).length;
    if (!u.swaps.length && counted) more.push(`the display got about ${Math.round(counted * dur / sum(vi.map((v) => v.s)))} frames (SkyLight's update count)`);
    else if (u.by.own.includes("signposts") && counted > 20 && heard < 0.8 * counted) more.push(`(the signpost stream lost frames here: SkyLight counted ${counted} display updates, ${heard} were reported)`);
    const vbl = median(vi.map((v) => v.vbl ?? NaN).filter(Number.isFinite));
    if (vbl > 1.15 * periodMs) more.push(`the display itself refreshed every ${ms(vbl)} here (${r0(1000 / vbl)} Hz), not every ${ms(periodMs)}: no app can show more than that`);
    if (parts.length) L.push(`${name(i)}: ${parts.join(" · ")}`);
    else if (more.length) L.push(`${name(i)}:`);
    for (const m of more) L.push(`  ${m}`);
  });
  if (u.cost.length && segs.length) {
    const moving = u.cost.filter((c) => inSeg(c.t - c.ms / 2000)), rest = u.cost.filter((c) => !inSeg(c.t) && !inSeg(c.t - c.ms / 1000));
    const tell = (v: Cost[]) => {
      const f = (k: keyof Cost) => mean(v.map((c) => c[k] as number).filter((x) => typeof x === "number"));
      // Apple silicon reports no GPU time per process (the column is always 0), so the GPU is told as power, whole machine.
      const gpu = (k: "app_gpu" | "ws_gpu") => (f(k) > 0 ? `, ${r0(f(k))} ms/s GPU` : "");
      return `app ${r0(f("app_cpu"))} ms/s CPU${gpu("app_gpu")} · window server ${r0(f("ws_cpu"))} ms/s CPU${gpu("ws_gpu")} · whole machine: GPU ${r0(f("gpu_mw"))} mW, CPU ${r0(f("cpu_mw"))} mW`;
    };
    if (moving.length) L.push(`cost while moving: ${tell(moving)}`);
    if (moving.length && rest.length) L.push(`cost at rest:      ${tell(rest)}`);
    if (!moving.length) L.push(`cost: the motion was shorter than one 100ms power sample; at rest: ${rest.length ? tell(rest) : "not sampled"}`);
  }
  // What the kernel billed to the app alone (CPU only: no process is billed for the GPU).
  if (u.vitals.length && segs.length) {
    const moving = u.vitals.filter((v) => inSeg(v.t - v.s / 2)), rest = u.vitals.filter((v) => !inSeg(v.t) && !inSeg(v.t - v.s));
    const tell = (v: Vital[]) => {
      const s = sum(v.map((x) => x.s)), mj = sum(v.map((x) => x.mj)), p = sum(v.map((x) => x.pmj));
      return `${r0(mj / s)} mW${mj > 0 ? ` (${r0((100 * p) / mj)}% on performance cores)` : ""}, ${r0((1000 * sum(v.map((x) => x.cpu))) / s)} ms/s CPU, ${r0(sum(v.map((x) => x.wk)) / s)} wakeups/s`;
    };
    if (moving.length) L.push(`the app's own energy while moving: ${tell(moving)} · ${sum(moving.map((x) => x.mj)).toFixed(1)} mJ in all (rusage)`);
    if (moving.length && rest.length) L.push(`the app's own energy at rest:      ${tell(rest)}`);
    if (!moving.length && rest.length) L.push(`the app's own energy: the motion was shorter than one 50ms sample; at rest: ${tell(rest)} (rusage)`);
  }
  return L;
}
