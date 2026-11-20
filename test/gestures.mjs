// bun test/gestures.mjs — the input actor's trackpad ops (pinch, rotate, smart_zoom, swipe, scroll momentum, press,
// force_click) checked against what AppKit actually hands a view, through the real event path. Holds the eye's input lock
// for the whole run (3·2·1 countdown first; Esc ×6 releases it), so your own trackpad/keyboard can't interfere.
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
mkdirSync("/tmp/the-eye-test", { recursive: true });
const gt = "/tmp/the-eye-test/gesture-target";
const b = spawnSync("swiftc", ["-O", `${root}test/gesture-target.swift`, "-o", gt], { encoding: "utf8" });
if (b.status !== 0) { console.error(b.stderr); process.exit(1); }

// Look up by force click on for this process only (argument domain), whatever the system setting is.
const target = spawn(gt, ["-com.apple.trackpad.forceClick", "YES"]);
const seen = [];
let ready;
const up = new Promise((r) => (ready = r));
createInterface({ input: target.stdout }).on("line", (l) => {
  const o = JSON.parse(l);
  if (o.kind === "ready") ready(o); else seen.push(o);
});
const win = await up;
const cx = win.x + win.w / 2, cy = win.y + win.h / 2;

const lock = spawn(`${root}bin/eye-capture`, ["lock", "--seconds", "40", "--allow", "tagged"], { stdio: ["ignore", "pipe", "pipe"] });
await new Promise((res, rej) => {
  let err = "";
  lock.stderr.on("data", (d) => { err += d; if (err.includes("locked for")) res(); });
  lock.on("close", () => rej(new Error(`lock failed: ${err}`)));
});
const actor = spawn(`${root}bin/eye-capture`, ["input"]);
const replies = createInterface({ input: actor.stdout })[Symbol.asyncIterator]();
const send = async (cmd) => { actor.stdin.write(JSON.stringify(cmd) + "\n"); return JSON.parse((await replies.next()).value); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Run one command and return the events the view got for it. */
const run = async (cmd) => {
  const from = seen.length;
  const r = await send({ ...cmd, require_pid: win.pid });
  if (!r.ok) console.log("  actor:", r.error);
  await sleep(150);
  return { r, ev: seen.slice(from) };
};

let failed = 0;
const check = (name, ok, detail) => { console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); if (!ok) failed++; };
// NSEvent.Phase: began 1, changed 4, ended 8.
const of = (ev, kind) => ev.filter((e) => e.kind === kind);

await send({ op: "move", x: cx, y: cy, ms: 0 });
await sleep(200);
{
  const { ev } = await run({ op: "click" });
  const k = ev.map((e) => e.kind).filter((x) => x !== "raw").join(",");
  check("plain click lands on the test window", k === "mouseDown,mouseUp", k);
}

{
  const { ev } = await run({ op: "pinch", scale: 2, ms: 200 });
  const m = of(ev, "magnify"), prod = m.reduce((p, e) => p * (1 + e.m), 1);
  check("pinch scale 2", Math.abs(prod - 2) < 1e-3 && m[0]?.phase === 1 && m.at(-1)?.phase === 8, `${m.length} magnify events, product ${prod.toFixed(4)}`);
}
{
  const { ev } = await run({ op: "pinch", scale: 0.5, ms: 200 });
  const prod = of(ev, "magnify").reduce((p, e) => p * (1 + e.m), 1);
  check("pinch scale 0.5", Math.abs(prod - 0.5) < 1e-3, `product ${prod.toFixed(4)}`);
}
{
  const { ev } = await run({ op: "rotate", degrees: 90, ms: 200 });
  const sum = of(ev, "rotate").reduce((s, e) => s + e.r, 0);
  check("rotate 90° clockwise", Math.abs(sum + 90) < 1e-3, `AppKit rotation sum ${sum.toFixed(3)} (counter-clockwise positive)`);
}
{
  const { ev } = await run({ op: "smart_zoom" });
  check("smart_zoom", of(ev, "smartMagnify").length === 1);
}
{
  const { ev } = await run({ op: "swipe", direction: "right" });
  const s = of(ev, "swipe");
  check("swipe right", s.length === 1 && s[0].dx < 0, JSON.stringify(s[0]));
}
{
  const { ev } = await run({ op: "scroll", dy: -10, events: 5, momentum: true });
  const s = of(ev, "scroll");
  check("scroll with momentum", s.some((e) => e.momentum === 1) && s.some((e) => e.momentum === 8) && s.every((e) => e.precise), `${s.length} scroll events, momentum phases ${[...new Set(s.map((e) => e.momentum))].join(",")}`);
}
{
  const { r, ev } = await run({ op: "press", force: [0, 0.6, 0], ms: 250 });
  const p = of(ev, "pressure"), peak = Math.max(...p.map((e) => e.p));
  const order = ev.filter((e) => ["mouseDown", "mouseUp", "quickLook"].includes(e.kind)).map((e) => e.kind).join(",");
  check("press to 0.6 (light, stays in stage 1)", Math.abs(peak - 0.6) < 0.02 && p.every((e) => e.stage <= 1) && order === "mouseDown,mouseUp" && !r.force_clicked,
    `${p.length} pressure events, peak ${peak.toFixed(3)}, ${order}`);
}
{
  const { r, ev } = await run({ op: "force_click" });
  const p = of(ev, "pressure"), stages = [...new Set(p.map((e) => e.stage))];
  const order = ev.filter((e) => ["mouseDown", "mouseUp", "quickLook"].includes(e.kind)).map((e) => e.kind).join(",");
  check("force_click reaches stage 2", stages.includes(2) && r.force_clicked && p.at(-1)?.stage === 0, `stages ${stages.join("→")}, ${order}`);
  check("force_click: mouse down/up around it", order.startsWith("mouseDown") && order.endsWith("mouseUp"), order);
  // Not a failure: AppKit does not derive quickLook (Look up) from the pressure stream, a real trackpad's comes from
  // lower in the system. Apps that read pressureChange / stage / pressureBehavior get the full press.
  console.log(`info quickLook (Look up) ${order.includes("quickLook") ? "arrived" : "not sent: only pressure-driven behavior is reproduced"}`);
  const t = p.filter((e) => e.stage === 1).map((e) => e.st);
  check("stageTransition climbs toward the force click", Math.max(...t) > 0.9, `max ${Math.max(...t).toFixed(3)}`);
}

actor.stdin.end();
target.kill();
lock.kill("SIGTERM");
console.log(failed ? `${failed} FAILED` : "all passed");
process.exit(failed ? 1 : 0);
