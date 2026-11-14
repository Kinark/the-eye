// node test/lock.mjs — the lock: countdown, cursor pin, preflight, quick style. Takes the real lock twice
// (3·2·1 then ~3s orange; then a ~0.5s "Just a sec…" pill). Esc ×6 releases either.
// 1. The tap must stay off during the countdown: an untagged event posted mid-countdown is never seen by it, one
//    posted after engaging is (and is blocked). Before the fix, disabling the fresh tap re-armed it mid-countdown.
// 2. Move your trackpad/mouse while it's locked: the trackpad is seized, so the cursor must not move; max_cursor_drift_pt reports how far it got (should be 0).
// 3. A second lock started while one is engaged must refuse in preflight — before any countdown — and leave the first alone.
// 4. --style quick engages with no countdown, answers "release" on stdin, and reports style + settle_ms.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
const bin = `${root}bin/eye-capture`;
mkdirSync("/tmp/the-eye-test", { recursive: true });
const src = "/tmp/the-eye-test/poke.swift", poke = "/tmp/the-eye-test/poke";
// One zero-delta scroll from a separate, untagged process: no visible effect, but its pid shows up in the lock's report.
writeFileSync(src, `import CoreGraphics
let e = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: 0, wheel2: 0, wheel3: 0)!
e.post(tap: .cghidEventTap)
print(getpid())`);
const b = spawnSync("swiftc", ["-O", src, "-o", poke], { encoding: "utf8" });
if (b.status !== 0) { console.error(b.stderr); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pokeNow = () => spawnSync(poke, { encoding: "utf8" }).stdout.trim();

function startLock(args) {
  const p = spawn(bin, ["lock", ...args], { stdio: ["pipe", "pipe", "pipe"] });
  const s = { p, out: "", err: "", t0: performance.now(), engagedAt: null };
  p.stdout.on("data", (d) => (s.out += d));
  p.stderr.on("data", (d) => {
    s.err += d;
    if (s.engagedAt == null && s.err.includes("locked for")) s.engagedAt = performance.now();
  });
  s.closed = new Promise((r) => p.on("close", (code) => r(code)));
  s.engaged = Promise.race([
    new Promise((r) => { const t = setInterval(() => { if (s.engagedAt != null) { clearInterval(t); r(true); } }, 10); }),
    s.closed.then(() => false),
  ]);
  s.report = () => { try { return JSON.parse(s.out.trim().split("\n").at(-1)); } catch { return {}; } };
  return s;
}

let failed = 0;
const check = (name, ok, detail) => { console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); if (!ok) failed++; };

// ── full lock ──
const full = startLock(["--seconds", "3", "--allow", "tagged"]);
await sleep(700); // mid-countdown
const early = pokeNow();
const engaged = await full.engaged;
await sleep(200);
const late = pokeNow();

// A rival lock while this one holds the devices: must refuse up front.
const rival = startLock(["--seconds", "2", "--style", "quick"]);
const rivalCode = await rival.closed;
const rivalMs = Math.round(performance.now() - rival.t0);
check("second lock refuses in preflight", rivalCode !== 0 && /preflight/.test(rival.err) && rival.engagedAt == null,
  `exit ${rivalCode} in ${rivalMs}ms: ${rival.err.trim().split("\n").at(-1)}`);

await full.closed;
const rep = full.report();
const seen = rep.pointer_events_by_source_pid ?? {};
check("lock engages after the countdown and runs to its timeout", engaged && rep.ended === "timeout", rep.ended);
check("tap is off during the countdown", !seen[early], `mid-countdown event seen ${seen[early] ?? 0}×`);
check("tap is on once locked", seen[late] >= 1, `post-engage event seen ${seen[late] ?? 0}×`);
check("full report says style full", rep.style === "full", rep.style);
console.log(`info max_cursor_drift_pt ${rep.max_cursor_drift_pt} (physical events blocked: ${rep.blocked})`);

// ── quick lock ──
await sleep(300);
const quick = startLock(["--seconds", "5", "--style", "quick", "--allow", "tagged"]);
const qEngaged = await quick.engaged;
const qMs = Math.round((quick.engagedAt ?? performance.now()) - quick.t0);
quick.p.stdin.write("extend 4\n");
await sleep(400);
quick.p.stdin.write("release\n");
const qCode = await quick.closed;
const q = quick.report();
check("quick lock engages with no countdown", qEngaged && qMs < 1000, `${qMs}ms from spawn (incl. process start + settle ${q.settle_ms}ms)`);
check("quick lock accepts extend", /extended 4(\.0)?s/.test(quick.err), quick.err.match(/extended[^\n]*/)?.[0] ?? "no ack");
check("quick lock ends on stdin release", qCode === 0 && q.ended === "released", `${q.ended}, exit ${qCode}`);
check("quick report has style + settle_ms", q.style === "quick" && typeof q.settle_ms === "number", `style ${q.style}, settle_ms ${q.settle_ms}`);
if (q.interrupted_at_engage) console.log(`info interrupted_at_engage ${q.interrupted_at_engage.join(", ")}`);

console.log(failed ? `${failed} FAILED` : "all passed");
process.exit(failed ? 1 : 0);
