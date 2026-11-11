// node test/lock.mjs — the lock's countdown and cursor pin. Takes the real lock (3·2·1 first, ~3s locked; Esc ×6 releases).
// 1. The tap must stay off during the countdown: an untagged event posted mid-countdown is never seen by it, one
//    posted after engaging is (and is blocked). Before the fix, disabling the fresh tap re-armed it mid-countdown.
// 2. Move your trackpad/mouse while it's locked: max_cursor_drift_pt reports how far the cursor got (should be 0).
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
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

const lock = spawn(`${root}bin/eye-capture`, ["lock", "--seconds", "3", "--allow", "tagged"], { stdio: ["ignore", "pipe", "pipe"] });
let out = "", err = "";
lock.stdout.on("data", (d) => (out += d));
lock.stderr.on("data", (d) => (err += d));
const closed = new Promise((r) => lock.on("close", r));
await sleep(700); // mid-countdown
const early = pokeNow();
const engaged = await Promise.race([
  new Promise((r) => { const t = setInterval(() => { if (err.includes("locked for")) { clearInterval(t); r(true); } }, 20); }),
  closed.then(() => false),
]);
await sleep(200);
const late = pokeNow();
await closed;
const rep = JSON.parse(out.trim().split("\n").at(-1));
const seen = rep.pointer_events_by_source_pid ?? {};
let failed = 0;
const check = (name, ok, detail) => { console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); if (!ok) failed++; };
check("lock engages after the countdown and runs to its timeout", engaged && rep.ended === "timeout", rep.ended);
check("tap is off during the countdown", !seen[early], `mid-countdown event seen ${seen[early] ?? 0}×`);
check("tap is on once locked", seen[late] >= 1, `post-engage event seen ${seen[late] ?? 0}×`);
console.log(`info max_cursor_drift_pt ${rep.max_cursor_drift_pt} (physical events blocked: ${rep.blocked})`);
console.log(failed ? `${failed} FAILED` : "all passed");
process.exit(failed ? 1 : 0);
