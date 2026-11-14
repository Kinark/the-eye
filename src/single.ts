// One-at-a-time rules.
// 1. Driver turn: several MCP clients (Claude Code, OpenCode sessions) each start their own the-eye server, but there
//    is one screen, one pointer and one keyboard. Tools that drive or own them (eye_act, eye_glance, eye_lock,
//    eye_record, eye_probe, eye_app) take turns through a lease in a shared file. A call that finds another server
//    mid-turn joins a FIFO queue and waits inside the server, so the agent gets its real result instead of a "BUSY,
//    retry" it has to babysit. An idle holder (between its agent's calls) hands over at once when someone is waiting;
//    a busy one (call in flight, lock, recording, probe) finishes first. Read-only tools never queue.
// 2. Single app instance: two copies of the app under test (an Xcode run + an `open`, a stale launch) both draw on
//    screen and both answer AX, so presses, probes and measurements hit the wrong one. Targets are checked first.
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, watch as fsWatch, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const DIR = process.env.THE_EYE_LEASE_DIR || join(homedir(), "Library", "Caches", "the-eye");
const LEASE = join(DIR, "driver.json");
const QUEUE = join(DIR, "queue");
const MUTEX = join(DIR, "driver.lock");
/** How long an idle lease outlives its last driving call when nobody is waiting (keeps an agent's calls together). */
const IDLE_MS = 60_000;
/** Longest a call waits in the queue before answering anyway (MCP clients commonly time out at 60s). */
const MAX_WAIT_MS = Number(process.env.EYE_QUEUE_WAIT_MS) || 45_000;
/** A call that gave up waiting keeps its place this long, so calling again doesn't go to the back. */
const KEEP_PLACE_MS = 20_000;

type Lease = { pid: number; cwd: string; tool: string; since: number; expires: number; busy?: boolean };
type Ticket = { pid: number; cwd: string; tool: string; since: number; expires: number };

const aliveP = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; } };
const readJson = <T,>(f: string): T | null => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } };
function writeJson(f: string, v: unknown) {
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(v));
  renameSync(tmp, f);
}
const readLease = () => readJson<Lease>(LEASE);
const live = (l: { pid: number; expires: number } | null): boolean => !!l && l.expires > Date.now() && aliveP(l.pid);
/** Older the-eye servers write no busy flag: treat them as busy until their lease runs out. */
const yields = (l: Lease) => l.busy === false;

const nap = new Int32Array(new SharedArrayBuffer(4));
/** Cross-process critical section (mkdir is atomic). Every op inside is a few small file reads/writes. */
function locked<T>(f: () => T): T {
  mkdirSync(QUEUE, { recursive: true });
  let got = false;
  for (let i = 0; i < 500 && !got; i++) {
    try { mkdirSync(MUTEX); got = true; } catch (e: any) {
      if (e?.code !== "EEXIST") break;
      try { if (Date.now() - statSync(MUTEX).mtimeMs > 2000) { rmdirSync(MUTEX); continue; } } catch {}
      Atomics.wait(nap, 0, 0, 2);
    }
  }
  try { return f(); } finally { if (got) try { rmdirSync(MUTEX); } catch {} }
}

const ticketFile = (pid = process.pid) => join(QUEUE, `${pid}.json`);
function tickets(): Ticket[] {
  let names: string[] = [];
  try { names = readdirSync(QUEUE).filter((n) => /^\d+\.json$/.test(n)); } catch {}
  const out: Ticket[] = [];
  for (const n of names) {
    const t = readJson<Ticket>(join(QUEUE, n));
    if (t && live(t)) out.push(t);
    else try { unlinkSync(join(QUEUE, n)); } catch {}
  }
  return out.sort((a, b) => a.since - b.since || a.pid - b.pid);
}
const dropTicket = () => { try { unlinkSync(ticketFile()); } catch {} };

let inFlight = 0;
let holding: () => boolean = () => false;
const busyNow = () => inFlight > 0 || holding();

const secs = (ms: number) => `${Math.max(0, Math.round(ms / 1000))}s`;
const ago = (t: number) => `${secs(Date.now() - t)} ago`;
const who = (x: { pid: number; cwd: string }) => `the-eye server pid ${x.pid} (session in ${x.cwd})`;
const describe = (l: Lease) =>
  `${who(l)}, driving since ${ago(l.since)}, last via ${l.tool}, ${l.busy === undefined ? `older the-eye: holds until its lease ends in ${secs(l.expires - Date.now())}` : l.busy ? "mid-turn" : "idle"}`;

/** One attempt: take or renew the lease if it's ours to take. Called under the mutex. */
function tryTake(tool: string): boolean {
  const cur = readLease();
  const now = Date.now();
  if (cur && cur.pid === process.pid && live(cur)) {
    writeJson(LEASE, { ...cur, tool, busy: true, expires: now + IDLE_MS });
    return true;
  }
  if (cur && live(cur) && !yields(cur)) return false;
  const head = tickets()[0];
  if (head && head.pid !== process.pid) return false;
  writeJson(LEASE, { pid: process.pid, cwd: process.cwd(), tool, since: now, expires: now + IDLE_MS, busy: true } satisfies Lease);
  dropTicket();
  return true;
}

type Extra = {
  signal?: AbortSignal;
  _meta?: { progressToken?: string | number };
  sendNotification?: (n: { method: "notifications/progress"; params: { progressToken: string | number; progress: number; total?: number; message?: string } }) => Promise<void>;
};

/** Wait for this server's turn at the screen. Resolves null once it's ours, or a message to hand back instead. */
async function takeTurn(tool: string, extra?: Extra): Promise<string | null> {
  if (locked(() => tryTake(tool))) { inFlight++; return null; }
  const t0 = Date.now();
  const mine = () => readJson<Ticket>(ticketFile());
  const enqueue = () => locked(() => {
    const prev = mine();
    const since = prev && live(prev) ? prev.since : Date.now();
    writeJson(ticketFile(), { pid: process.pid, cwd: process.cwd(), tool, since, expires: Date.now() + KEEP_PLACE_MS } satisfies Ticket);
  });
  enqueue();
  let wake: () => void = () => {};
  const watchers = [LEASE, QUEUE].flatMap((p) => { try { return [fsWatch(p === LEASE ? DIR : p, () => wake())]; } catch { return []; } });
  const onAbort = () => wake();
  extra?.signal?.addEventListener("abort", onAbort);
  let lastNote = 0;
  try {
    for (;;) {
      if (extra?.signal?.aborted) { locked(dropTicket); return "cancelled while queued for the screen; nothing was done"; }
      if (locked(() => tryTake(tool))) { inFlight++; return null; }
      const waited = Date.now() - t0;
      const line = () => {
        const q = tickets(), pos = q.findIndex((t) => t.pid === process.pid) + 1;
        const l = readLease();
        return { pos, of: q.length, holder: l && live(l) ? describe(l) : "nobody (handing over)" };
      };
      if (waited >= MAX_WAIT_MS) {
        const s = line();
        return `QUEUED, not run: waited ${secs(waited)} for the screen and it is still taken — ${s.holder}. You are #${s.pos || 1} in line; ` +
          `call again within ${secs(KEEP_PLACE_MS)} to keep your place (it waits up to ${secs(MAX_WAIT_MS)} more). Nothing was done. ` +
          `Read-only tools (eye_inspect, eye_snapshot, eye_status, eye_report, eye_peek) work meanwhile.`;
      }
      enqueue(); // refresh our place (expires) while we're actually waiting
      if (extra?._meta?.progressToken !== undefined && extra.sendNotification && Date.now() - lastNote >= 2000) {
        lastNote = Date.now();
        const s = line();
        extra.sendNotification({ method: "notifications/progress", params: {
          progressToken: extra._meta.progressToken, progress: waited, total: MAX_WAIT_MS,
          message: `queued for the screen: #${s.pos} of ${s.of}, behind ${s.holder}`,
        } }).catch(() => {});
      }
      await new Promise<void>((r) => { const t = setTimeout(r, 1000); wake = () => { clearTimeout(t); r(); }; });
    }
  } finally {
    for (const w of watchers) w.close();
    extra?.signal?.removeEventListener("abort", onAbort);
  }
}

/** Write our current busy state into the lease (if it's still ours). */
function settleLease() {
  locked(() => {
    const cur = readLease();
    if (cur?.pid !== process.pid) return;
    const busy = busyNow();
    writeJson(LEASE, { ...cur, busy, expires: busy ? Math.max(cur.expires, Date.now() + 15_000) : Math.max(cur.expires, Date.now() + IDLE_MS) });
  });
}

/**
 * Wrap a tool handler that drives the screen: it waits its turn (FIFO across every the-eye server), runs, then
 * marks the lease idle so a waiting session can go. `tool` may be a function returning null for calls that only
 * read (e.g. eye_app list, eye_lock release) — those run straight away.
 */
export function driving<P, R extends { content: any[]; isError?: boolean }>(
  tool: string | ((p: P) => string | null), fail: (t: string) => R, fn: (p: P, extra: any) => Promise<R>,
) {
  return async (p: P, extra: any): Promise<R> => {
    const name = typeof tool === "string" ? tool : tool(p);
    if (!name) return fn(p, extra);
    const t0 = Date.now();
    const refused = await takeTurn(name, extra);
    if (refused) return fail(refused);
    const waited = Date.now() - t0;
    let r: R;
    try { r = await fn(p, extra); } finally { inFlight--; settleLease(); }
    const notes: string[] = [];
    if (waited >= 500) notes.push(`(waited ${(waited / 1000).toFixed(1)}s in the queue for another session's turn first)`);
    const others = tickets().filter((t) => t.pid !== process.pid);
    if (others.length) {
      notes.push(`⏳ ${others.length} other session${others.length > 1 ? "s are" : " is"} queued for the screen (${others.map((t) => `pid ${t.pid} via ${t.tool}`).join(", ")}). ` +
        (holding() ? "They wait until your lock / recording / probe ends — end it as soon as you can." : "Your turn passes to them now; your next driving call queues behind them."));
    }
    if (notes.length && Array.isArray(r?.content)) r = { ...r, content: [...r.content, { type: "text", text: notes.join("\n") }] };
    return r;
  };
}

/** Keep the lease's busy flag honest while this server has something running (recording, lock, probe). */
export function startLeaseHeartbeat(busy: () => boolean) {
  holding = busy;
  const t = setInterval(() => { if (readLease()?.pid === process.pid) settleLease(); }, 2000);
  t.unref();
}
export function releaseDriver() {
  try { locked(() => { if (readLease()?.pid === process.pid) unlinkSync(LEASE); dropTicket(); }); } catch {}
}
export function driverStatus(): string {
  const l = readLease();
  const q = tickets();
  const queue = q.length ? `\nqueue: ${q.map((t, i) => `#${i + 1} ${t.pid === process.pid ? "this session" : who(t)} via ${t.tool}, waiting ${secs(Date.now() - t.since)}`).join("; ")}` : "";
  if (!l || !live(l)) return `driver lease: free${queue}`;
  return (l.pid === process.pid ? `driver lease: this session (since ${ago(l.since)}, ${busyNow() ? "mid-turn" : "idle"})` : `driver lease: ${describe(l)}`) + queue;
}

// ---- single app instance
//
// An app "family" is every build of the same app: the same executable name, or the same stem once build-variant
// words are dropped (NOOTCH!-Dev / NOOTCH! / "NOOTCH! Beta" → nootch), or the same bundle-id stem
// (fi.lo.dev.nootch / lo.fi.NOOTCH → nootch). Two family members on screen at once (two Xcode runs, a Dev build
// next to the installed release) both draw and both answer AX, so presses, probes and measurements can hit the
// wrong one. The server checks this itself on every driving call, watches watched families for new launches,
// and hands the agent the choices instead of guessing.

type Proc = { pid: number; exe: string; app?: string; name: string; bundleId?: string; elapsed: number; keys: string[] };
const VARIANTS = new Set(["dev", "debug", "development", "beta", "alpha", "release", "setapp", "appstore", "store", "staging",
  "test", "testing", "preview", "canary", "nightly", "local", "prod", "production", "internal"]);
/** [[dd-]hh:]mm:ss → seconds */
function etime(s: string) {
  const [d, rest] = s.includes("-") ? s.split("-") : ["0", s];
  return rest.split(":").map(Number).reduce((a, b) => a * 60 + b, 0) + Number(d) * 86400;
}
const bundleIds = new Map<string, string | undefined>();
function bundleIdOf(app: string) {
  if (!bundleIds.has(app)) {
    const r = spawnSync("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", join(app, "Contents", "Info.plist")], { encoding: "utf8" });
    bundleIds.set(app, r.status === 0 ? r.stdout.trim() : undefined);
  }
  return bundleIds.get(app);
}
export function familyKeys(name: string, bundleId?: string): string[] {
  const keys = new Set<string>();
  const words = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const stem = words.filter((w) => !VARIANTS.has(w)).join("");
  if (stem.length >= 3) keys.add(`n:${stem}`);
  if (bundleId) {
    const parts = bundleId.toLowerCase().split(".").filter((w) => w && !VARIANTS.has(w));
    const last = parts[parts.length - 1]?.replace(/[^a-z0-9]/g, "");
    if (last && last.length >= 3 && !["app", "mac", "macos", "osx", "helper"].includes(last)) keys.add(`n:${last}`);
  }
  return [...keys];
}
function apps(): Proc[] {
  const r = spawnSync("/bin/ps", ["-axo", "pid=,etime=,comm="], { encoding: "utf8" });
  return (r.stdout ?? "").split("\n").map((l) => l.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/)).filter(Boolean)
    .map((m) => ({ pid: Number(m![1]), elapsed: etime(m![2]), exe: m![3] }))
    .filter((p) => /\.app\/Contents\/MacOS\/[^/]+$/.test(p.exe))
    .map((p) => {
      const app = p.exe.replace(/\/Contents\/MacOS\/[^/]+$/, "");
      const name = basename(p.exe), bundleId = bundleIdOf(app);
      return { ...p, app, name, bundleId, keys: [`x:${name.toLowerCase()}`, ...familyKeys(name, bundleId)] };
    });
}
const related = (a: Proc, b: Proc) => a.keys.some((k) => b.keys.includes(k));
const newest = (l: Proc[]) => [...l].sort((a, b) => a.elapsed - b.elapsed)[0];
const isBuild = (p: Proc) => !!p.app && /\/(DerivedData|Build\/Products)\//.test(p.app) && !/^(\/System|\/Applications|\/Users\/[^/]+\/Applications)\//.test(p.app);
/**
 * An older copy is stale, and safe to quit without asking, when a newer copy of the same thing has started: the same
 * .app relaunched (Xcode Run without stopping the old run, `open -n`), or a newer build product of the family while
 * the older one is a build product too. Copies the user may be using (anything outside build folders, e.g.
 * /Applications) are never stale: those still go through `duplicates`.
 */
const stale = (old: Proc, fresh: Proc) => old.elapsed >= fresh.elapsed && old.pid !== fresh.pid && (old.app === fresh.app || (isBuild(old) && isBuild(fresh)));
/** pid quit as stale → the pid that replaced it, so calls naming the old pid follow the new launch. */
const replaced = new Map<number, number>();
function successor(pid: number): number | undefined {
  let p = pid, seen = 0;
  while (replaced.has(p) && seen++ < 20) p = replaced.get(p)!;
  return p !== pid && aliveP(p) ? p : undefined;
}
/** Quit every stale family member older than `fresh`. Returns a line for the tool output, or "". */
async function retireStale(fresh: Proc, members: Proc[]): Promise<string> {
  const old = members.filter((p) => stale(p, fresh));
  if (!old.length) return "";
  const left = await quit(old.map((p) => p.pid));
  for (const p of old) if (!left.includes(p.pid)) replaced.set(p.pid, fresh.pid);
  const gone = old.filter((p) => !left.includes(p.pid));
  return [
    gone.length ? `quit stale ${gone.map((p) => `${p.name} pid ${p.pid} (started ${fmtAge(p.elapsed)} ago)`).join(", ")}: a newer launch of the same build is running, ${fresh.name} pid ${fresh.pid}, which is the one to test now` : "",
    left.length ? `could NOT quit stale pid ${left.join(", ")}, so two copies are still running` : "",
  ].filter(Boolean).join("; ");
}

function pick(all: Proc[], proc: string | number): Proc | undefined {
  if (typeof proc === "number" || /^\d+$/.test(String(proc))) return all.find((p) => p.pid === Number(proc));
  const want = String(proc).toLowerCase();
  return newest(all.filter((p) => p.name.toLowerCase() === want))
    ?? newest(all.filter((p) => p.name.toLowerCase().includes(want)))
    ?? newest(all.filter((p) => p.app?.toLowerCase().endsWith(`/${want}.app`)))
    ?? newest(all.filter((p) => familyKeys(String(proc)).some((k) => p.keys.includes(k))));
}

export type InstancePolicy = "ask" | "quit_others" | "relaunch" | "allow";
export type InstanceCheck = { ok: true; pid?: number; note?: string } | { ok: false; error: string; pid?: number; note?: string };
const line = (p: Proc, mark = "") => `  pid ${p.pid}  ${p.name}  started ${fmtAge(p.elapsed)} ago  ${p.app}${mark}`;

/** Every running member of `proc`'s family (the target first), or null when nothing matches. */
export function familyOf(proc: string | number): { target: Proc; others: Proc[] } | null {
  const all = apps();
  const target = pick(all, proc);
  if (!target) return null;
  return { target, others: all.filter((p) => p.pid !== target.pid && related(p, target)) };
}

async function quit(pids: number[]) {
  for (const pid of pids) { try { process.kill(pid, "SIGTERM"); } catch {} }
  for (let i = 0; i < 30 && pids.some(aliveP); i++) await sleep(100);
  for (const pid of pids) if (aliveP(pid)) { try { process.kill(pid, "SIGKILL"); } catch {} }
  await sleep(200);
  return pids.filter(aliveP);
}
/** Launch an .app (never a second copy: `open` reuses a running one) and wait until its process is up. */
export async function launch(app: string, settleMs = 1500): Promise<Proc | string> {
  const exe = basename(app).replace(/\.app$/, "");
  const before = new Set(apps().map((p) => p.pid));
  const r = spawnSync("/usr/bin/open", [app], { encoding: "utf8" });
  if (r.status !== 0) return `open failed: ${(r.stderr || r.stdout).trim()}`;
  for (let i = 0; i < 200; i++) {
    const hit = apps().find((p) => !before.has(p.pid) && (p.app === app || p.name === exe));
    if (hit) { await sleep(settleMs); return hit; }
    await sleep(100);
  }
  return `${app} did not start within 20s`;
}

/**
 * The server's own check before it drives, probes or measures an app. `ask` (default) returns the situation plus
 * the choices; the others act: quit_others keeps the target (the pid you named, else the newest launch) and quits
 * every other family member; relaunch quits the whole family and starts the target's .app fresh (or `app_path`).
 */
export async function checkInstances(proc: string | number, policy: InstancePolicy = "ask", appPath?: string): Promise<InstanceCheck> {
  let redirect = "";
  if (/^\d+$/.test(String(proc)) && !aliveP(Number(proc))) {
    const next = successor(Number(proc));
    if (next) { redirect = `pid ${proc} was a stale copy, quit when pid ${next} launched: using pid ${next}`; proc = next; }
  }
  const r = await checkFamily(proc, policy, appPath);
  return redirect ? { ...r, note: [redirect, r.note].filter(Boolean).join("; ") } : r;
}

async function checkFamily(proc: string | number, policy: InstancePolicy, appPath?: string): Promise<InstanceCheck> {
  const fam = familyOf(proc);
  if (!fam) {
    if (policy === "relaunch" && appPath) {
      const l = await launch(appPath);
      return typeof l === "string" ? { ok: false, error: l } : { ok: true, pid: l.pid, note: `launched ${l.name} pid ${l.pid}` };
    }
    return { ok: true };
  }
  const { target, others } = fam;
  watch(target);
  if (policy === "allow") return { ok: true, pid: target.pid };
  if (policy === "relaunch") {
    const app = appPath ?? target.app!;
    const left = await quit([target.pid, ...others.map((p) => p.pid)]);
    if (left.length) return { ok: false, error: `could not quit pid ${left.join(", ")}` };
    const l = await launch(app);
    if (typeof l === "string") return { ok: false, error: l };
    watch(l);
    return { ok: true, pid: l.pid, note: `relaunched ${l.name}: pid ${l.pid} (quit ${[target, ...others].map((p) => p.pid).join(", ")})` };
  }
  if (!others.length) return { ok: true, pid: target.pid };
  if (policy === "ask") {
    // Stale copies (older launches of the same build) never need a decision: the newest launch wins.
    const all = [target, ...others], fresh = newest(all);
    const note = await retireStale(fresh, all);
    if (note) {
      const left = familyOf(fresh.pid);
      if (left && !left.others.length) return { ok: true, pid: fresh.pid, note: target.pid !== fresh.pid ? `${note}; using pid ${fresh.pid}, not pid ${target.pid}` : note };
      if (left) return { ok: false, error: `${note}\n${conflictText(left.target, left.others)}` };
    }
  }
  if (policy === "quit_others") {
    const left = await quit(others.map((p) => p.pid));
    if (left.length) return { ok: false, error: `could not quit pid ${left.join(", ")}` };
    return { ok: true, pid: target.pid, note: `quit ${others.map((p) => `${p.name} pid ${p.pid}`).join(", ")}; kept pid ${target.pid}` };
  }
  return { ok: false, error: conflictText(target, others) };
}

export function conflictText(target: Proc, others: Proc[]) {
  const n = others.length + 1;
  return [
    `STOPPED: ${n} copies of ${target.name}'s app are running (same app or another build of it). They all draw on screen and answer`,
    `accessibility, so presses, probes and measurements could hit the wrong one:`,
    line(target, "  ← target (the pid you named, else the newest launch)"),
    ...others.map((p) => line(p)),
    `Decide, then call again with one of:`,
    `  duplicates:"quit_others"  keep pid ${target.pid}, quit the other ${others.length}`,
    `  duplicates:"relaunch"     quit all ${n}, start ${target.app} fresh (add app_path to start a different build, e.g. the one you just built)`,
    `  duplicates:"allow"        test with all of them running`,
    `  or stop the test and ask the user (one of these may be the user's own copy). eye_app {app} lists them; eye_app {action:"quit", pid} quits one.`,
  ].join("\n");
}

// ---- watching: new launches of a family while this server is testing it

const watched = new Map<string, { name: string; keys: string[]; pids: Set<number> }>();
const events: { t: number; text: string }[] = [];
let watcher: NodeJS.Timeout | undefined;
export function watch(p: Proc) {
  const key = p.keys[0];
  const w = watched.get(key) ?? { name: p.name, keys: p.keys, pids: new Set<number>() };
  for (const q of apps()) if (q.keys.some((k) => w.keys.includes(k))) w.pids.add(q.pid);
  watched.set(key, w);
  if (!watcher) {
    let busy = false;
    watcher = setInterval(async () => {
      if (busy) return; // a quit in progress takes up to ~3.5s
      busy = true;
      try {
        const now = apps();
        for (const w of watched.values()) {
          const fam = now.filter((q) => q.keys.some((k) => w.keys.includes(k)));
          for (const q of fam) if (!w.pids.has(q.pid)) {
            w.pids.add(q.pid);
            if (fam.length < 2) continue;
            // A newer launch of the same build: the old copy is stale, quit it now instead of leaving two on screen.
            const note = await retireStale(q, fam);
            const left = familyOf(q.pid);
            if (note) events.push({ t: Date.now(), text: note });
            if (left?.others.length) events.push({ t: Date.now(), text: `another copy of ${w.name}'s app launched: ${q.name} pid ${q.pid} (${left.others.length + 1} running now: ${[left.target, ...left.others].map((f) => f.pid).join(", ")})` });
          }
          for (const pid of [...w.pids]) if (!fam.some((q) => q.pid === pid) && !aliveP(pid)) w.pids.delete(pid);
        }
      } finally { busy = false; }
    }, 750);
    watcher.unref();
  }
}
export function watchPid(pid: number) { const f = familyOf(pid); if (f) watch(f.target); }
/** Launch warnings since `since` (ms epoch), for peek/stop/act outputs. */
export function instanceEvents(since: number) { return events.filter((e) => e.t >= since).map((e) => `⚠ ${new Date(e.t).toLocaleTimeString()} ${e.text}`); }
let reported = 0;
/** Launch warnings not shown yet; every tool output appends them, so the agent hears about a new copy right away. */
export function freshEvents(): string[] {
  const out = events.slice(reported).map((e) => `⚠ ${new Date(e.t).toLocaleTimeString()} ${e.text}${e.text.startsWith("another copy of ") ? ` — eye_app {app:"${e.text.split("'s app")[0].replace("another copy of ", "")}"} for the choices` : ""}`);
  reported = events.length;
  return out;
}
export function watchedStatus(): string[] {
  const out: string[] = [];
  const all = apps();
  for (const w of watched.values()) {
    const fam = all.filter((q) => q.keys.some((k) => w.keys.includes(k)));
    out.push(`app ${w.name}: ${fam.length} running${fam.length > 1 ? " ⚠ more than one" : ""}${fam.length ? ` (${fam.map((p) => `${p.name} pid ${p.pid}`).join(", ")})` : ""}`);
  }
  return out;
}
export function listFamily(proc: string | number): string {
  const fam = familyOf(proc);
  if (!fam) return `no running app matches "${proc}"`;
  return [`${fam.others.length + 1} running:`, line(fam.target, "  ← target"), ...fam.others.map((p) => line(p))].join("\n");
}
export async function quitPids(pids: number[]) { return quit(pids); }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fmtAge = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`);
export const duplicatesSchemaDescription =
  "What to do when the target app runs more than once, counting other builds of it (Dev/Release…). ask (default): stop and list them with the choices. quit_others: keep the target (pid you named, else newest launch), quit the rest. relaunch: quit them all and start the target's .app fresh (or app_path). allow: go ahead.";
