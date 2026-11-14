// node test/took-back.mjs — Esc ×6 with real key presses (posted by an untagged process, as the user's are), through
// the server: (1) while the hand plays by itself between calls: the fingers lift, nothing more reaches the app and the
// session is ended; (2) in the middle of a long step (a glide, a pinch, a press): it stops, what it had open is
// closed, and the reply says who stopped it; (3) the next session works again. Also: a reply that comes while play
// has the fingers up says they are OFF the trackpad. TAKES THE REAL INPUT LOCK five times (3·2·1 each), about 50s.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname, tmp = "/tmp/the-eye-test";
mkdirSync(tmp, { recursive: true });
const gt = `${tmp}/gesture-target`, key = `${tmp}/key`;
writeFileSync(`${key}.swift`, `import CoreGraphics
import Foundation
let code = CGKeyCode(UInt16(CommandLine.arguments[1])!)
for down in [true, false] { CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down)!.post(tap: .cghidEventTap); usleep(8000) }
`);
for (const [src, out] of [[`${root}test/gesture-target.swift`, gt], [`${key}.swift`, key]]) {
  const b = spawnSync("swiftc", ["-O", src, "-o", out], { encoding: "utf8" });
  if (b.status !== 0) { console.error(b.stderr); process.exit(1); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc6 = async () => { for (let i = 0; i < 6; i++) { spawnSync(key, ["53"]); await sleep(40); } };
let failed = 0;
const check = (name, ok, detail) => { console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail !== undefined ? ` — ${detail}` : ""}`); if (!ok) failed++; };

const target = spawn(gt, []);
const seen = [], all = [];
const win = await new Promise((res) => createInterface({ input: target.stdout }).on("line", (l) => {
  const o = JSON.parse(l);
  if (o.kind === "ready") res(o); else if (o.kind === "scroll") seen.push(o); else all.push(o);
}));
const cx = Math.round(win.x + win.w / 2), cy = Math.round(win.y + win.h / 2);

const client = new Client({ name: "took-back", version: "1" });
await client.connect(new StdioClientTransport({ command: "node", args: [`${root}src/index.ts`], env: process.env }));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
  return r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
};
const pointer = () => JSON.parse(spawnSync(`${root}bin/eye-capture`, ["input"], { input: '{"op":"pos"}\n', encoding: "utf8" }).stdout.split("\n")[0]);
const open = { app: win.pid, frames: false, look: false, root: false, events: false, idle_s: 20 };

try {
  // ---- 1. playing by itself, nobody calling
  let t = await call("eye_drive", { ...open, label: "took-back-play", hold_ms: 15000, wing: `${cx},${cy} rest 300 fingers play wild 60 rest 1200` });
  check("the hand is playing when the call returns", /playing|play/.test(t) && seen.length > 20, `${seen.length} scroll events`);
  // Play lifts now and then to watch: a reply that comes just then says so, in words.
  let off = "";
  for (let i = 0; i < 80 && !off; i++) { const s = await call("eye_drive", { wing: "rest 100" }); if (/OFF the trackpad/.test(s)) off = s; }
  check("a reply while play has them up says the fingers are OFF the trackpad", !!off && !/TWO FINGERS DOWN/.test(off), off ? off.split("\n").find((l) => /OFF the trackpad/.test(l))?.replace(/.*(the two fingers are OFF[^.]*\.).*/, "$1") : "never lifted in 80 calls");
  let n = seen.length;
  await sleep(800);
  check("and goes on between calls", seen.length - n > 10, `${seen.length - n} more`);
  await esc6();
  await sleep(300);
  n = seen.length;
  await sleep(900);
  check("Esc ×6: nothing more reaches the app", seen.length === n && seen.at(-1)?.phase === 8, `${seen.length - n} events after, last phase ${seen.at(-1)?.phase}`);
  t = await call("eye_drive", { wing: "rest 100" });
  check("the session was ended, and the next call says by whom", /Esc ×6/.test(t), t.split("\n")[0].slice(0, 160));

  // ---- 2. in the middle of a long step
  const from = pointer();
  const going = call("eye_drive", { ...open, label: "took-back-step", steps: [{ op: "move", x: cx - 150, y: cy - 100, ms: 0 }, { op: "move", x: cx + 150, y: cy + 100, ms: 5000 }, { op: "click" }] });
  // The countdown, then the glide: Esc in the middle of it.
  for (let i = 0; i < 400; i++) { await sleep(25); const p = pointer(); if (Math.abs(p.x - (cx - 150)) < 3 && Math.abs(p.y - (cy - 100)) < 3) break; }
  await sleep(1200);
  const t0 = Date.now();
  await esc6();
  t = await going;
  const p = pointer();
  check("Esc ×6 during a step: the step stops where it is", Date.now() - t0 < 2000 && p.x < cx + 120, `answered ${Date.now() - t0}ms after, pointer at ${p.x.toFixed(0)},${p.y.toFixed(0)} of ${cx + 150},${cy + 100}`);
  check("the reply says the user took their input back, and the click was not sent", /TOOK THEIR INPUT BACK/.test(t), t.split("\n").find((l) => /TOOK|NOT SENT/.test(l))?.slice(0, 200));

  // ---- 2b. in the middle of a pinch and of a press: cut short, and ended properly (no gesture left open, no button held)
  for (const [name, step, kind] of [["pinch", { op: "pinch", scale: 3, ms: 4000 }, "magnify"], ["press", { op: "press", force: [0, 0.8, 0.8, 0], ms: 4000 }, "pressure"]]) {
    const a0 = all.length, of = () => all.slice(a0).filter((o) => o.kind === kind);
    const g = call("eye_drive", { ...open, label: `took-back-${name}`, steps: [{ op: "move", x: cx, y: cy, ms: 0 }, step, { op: "scroll", dy: -4, events: 10 }] });
    for (let i = 0; i < 400 && of().length < 8; i++) await sleep(25);
    const before = of().length, s0 = seen.length, t1 = Date.now();
    await esc6();
    t = await g;
    await sleep(200);
    const ev = of(), tail = all.slice(a0).map((o) => o.kind).filter((k) => /up|Up/.test(k));
    check(`Esc ×6 during a ${name}: it is cut short`, before >= 8 && Date.now() - t1 < 2200 && ev.length < 300, `${before} ${kind} events before, ${ev.length} in all (a whole one is ~480), answered ${Date.now() - t1 - 200}ms after`);
    check(`the ${name} is ended, not left open`, name === "pinch" ? ev.at(-1)?.phase === 8 : tail.length > 0 || ev.at(-1)?.phase === 8 || ev.at(-1)?.p === 0, `last ${kind} ${JSON.stringify(ev.at(-1))}${tail.length ? `, then ${tail.at(-1)}` : ""}`);
    check("the reply says who stopped it, and the step after was not sent", /TOOK THEIR INPUT BACK/.test(t) && seen.length === s0, `${seen.length - s0} scroll events after`);
  }

  // ---- 3. a new session's steps and wings run again
  n = seen.length;
  t = await call("eye_drive", { ...open, label: "took-back-after", steps: [{ op: "move", x: cx, y: cy, ms: 100 }, { op: "scroll", dy: -4, events: 10 }], end: true });
  check("the next session's steps run", seen.length - n >= 10 && !/TOOK THEIR INPUT BACK|NOT SENT/.test(t), `${seen.length - n} scroll events`);
  spawnSync(`${root}bin/eye-capture`, ["input"], { input: JSON.stringify({ op: "move", x: from.x, y: from.y, ms: 0 }) + "\n" });
} finally {
  try { await call("eye_drive", { end: true }); } catch { /* none open */ }
  await client.close();
  target.kill();
}
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
