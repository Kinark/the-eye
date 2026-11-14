// node test/watch-events.mjs — `the-eye watch` end to end.
// 1. A fixture app (test/fixtures/ticker.swift) that changes by itself: value-changed, title-changed, sheet
//    open/close with its text + buttons, --until on a value, --until on a window already showing, --seconds → 124.
//    No input is sent, so no lock is needed.
// 2. TextEdit driven with System Events keystrokes INSIDE eye_lock (taken through the server, so it waits its
//    turn in the driver queue): launch, window-opened, ⌘S save sheet, Esc, close, quit.
// 3. Calculator under eye_lock: results arrive as announcements (attributed-string payload).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "src", "index.ts");
const TICKER = "/tmp/eye-ticker";
let failed = 0;
const check = (ok, name, detail = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? " — " + detail : ""}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run `the-eye watch …`; resolves with its stdout lines and exit code. */
function watch(args) {
  const p = spawn("node", [CLI, "watch", ...args], { stdio: ["ignore", "pipe", "pipe"] });
  const lines = []; let buf = "", err = "";
  p.stdout.on("data", (d) => { buf += d; const parts = buf.split("\n"); buf = parts.pop(); lines.push(...parts); });
  p.stderr.on("data", (d) => (err += d));
  const done = new Promise((r) => p.on("exit", (code) => r({ code, lines, err })));
  return { p, lines, done, ready: (async () => { while (!lines.some((l) => / ready /.test(l))) await sleep(50); })() };
}
const has = (lines, re) => lines.some((l) => re.test(l));

// ---- 1. fixture
spawnSync("swiftc", ["-O", join(ROOT, "test", "fixtures", "ticker.swift"), "-o", TICKER]);
{
  const app = spawn(TICKER, { stdio: "ignore" });
  await sleep(300);
  const w = watch(["--app", String(app.pid), "--values", "--seconds", "6"]);
  const { lines, code } = await w.done;
  console.log(lines.map((l) => "     " + l).join("\n"));
  check(code === 0, "plain watch exits 0 at --seconds", `exit ${code}`);
  check(has(lines, /value-changed eye-ticker StaticText = "step \d"/), "value-changed for a label");
  check(has(lines, /ProgressIndicator = "100%"/), "progress shown as a percentage");
  check(has(lines, /title-changed eye-ticker "Ticker" → "Ticker — done"/), "title-changed old → new");
  check(has(lines, /sheet-opened eye-ticker — "Keep the result\?" \[(Discard \| Keep|Keep \| Discard)\]/), "sheet-opened with its text and buttons");
  check(!has(lines, /StaticText = "Keep the result\?"/), "alert text not repeated as a value change");
  check(has(lines, /sheet-closed eye-ticker/), "sheet-closed");
  check(!has(lines, /sheet-opened eye-ticker sheet/), "no 'sheet sheet' doubling");
  app.kill();
}
{
  const app = spawn(TICKER, { stdio: "ignore" });
  await sleep(300);
  const t0 = Date.now();
  const { lines, code } = await watch(["--app", String(app.pid), "--values", "--until", "build succeeded", "--seconds", "8"]).done;
  check(code === 0 && /= "Build Succeeded"/.test(lines.at(-1) ?? ""), "--until exits 0 on the matching line", `${lines.at(-1)} after ${Date.now() - t0}ms`);
  const already = await watch(["--app", String(app.pid), "--until", "ticker", "--seconds", "3"]).done;
  check(already.code === 0 && /already window-opened|already window eye-ticker/.test(already.lines.at(-1) ?? ""), "--until matches a window already showing", already.lines.at(-1));
  const never = await watch(["--app", String(app.pid), "--until", "nope-never", "--seconds", "1.5"]).done;
  check(never.code === 124 && /timeout after 1.5s/.test(never.lines.at(-1) ?? ""), "--seconds with no match exits 124", never.lines.at(-1));
  const json = await watch(["--app", String(app.pid), "--json", "--until", "ticker", "--seconds", "3"]).done;
  const last = JSON.parse(json.lines.at(-1) ?? "{}");
  check(last.matched === true && last.app === "eye-ticker" && typeof last.t === "number", "--json lines parse", json.lines.at(-1));
  app.kill();
}

// ---- 2. TextEdit, under the lock
spawnSync("pkill", ["-x", "TextEdit"]); await sleep(800);
const client = new Client({ name: "watch-events", version: "1" });
await client.connect(new StdioClientTransport({ command: "node", args: [CLI], stderr: "ignore" }));
const call = async (name, args) => (await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 })).content.map((c) => c.text).join("\n");
const w = watch(["--app", "TextEdit", "--seconds", "30"]);
await w.ready;
const lock = await call("eye_lock", { seconds: 25 });
check(/locked|lock/i.test(lock) && !/refused|QUEUED/.test(lock), "eye_lock taken for the TextEdit drive", lock.split("\n")[0]);
const osa = (...lines) => { try { execFileSync("osascript", lines.flatMap((l) => ["-e", l]), { stdio: "pipe" }); } catch (e) { console.log("     osascript: " + String(e.stderr).trim()); } };
osa('tell application "TextEdit" to activate', "delay 2",
  'tell application "TextEdit" to make new document with properties {text:"watched"}', "delay 1",
  'tell application "System Events" to keystroke "s" using command down', "delay 2",
  'tell application "System Events" to key code 53', "delay 1.5",
  'tell application "TextEdit" to close every document saving no', "delay 0.5",
  'tell application "TextEdit" to quit');
await sleep(1500);
const rel = await call("eye_lock", { release: true });
check(!/no active lock/.test(rel), "lock released", rel.split("\n")[0]);
await sleep(500);
w.p.kill("SIGTERM");
const lines = [...w.lines];
console.log(lines.map((l) => "     " + l).join("\n"));
check(has(lines, /app-launched TextEdit/), "app-launched");
check(has(lines, /window-opened TextEdit .*"Untitled/), "window-opened after a fresh launch");
check(has(lines, /sheet-opened TextEdit .*\[.*Save.*\]/), "⌘S save sheet with its buttons");
check(has(lines, /sheet-closed TextEdit/), "Esc → sheet-closed");
check(has(lines, /window-closed TextEdit/), "window-closed");
check(has(lines, /app-quit TextEdit/), "app-quit");
check(!has(lines, /window-focused TextEdit$/), "no untitled focus noise");

// ---- 3. Calculator, under the lock. It posts no AXValueChanged for its display; results arrive as
// AXAnnouncementRequested whose payload is an NSAttributedString ("Result, 46"), not a String.
{
  execFileSync("open", ["-a", "Calculator"]); await sleep(2500);
  const c = watch(["--app", "Calculator", "--until", "Result, 92", "--seconds", "25"]);
  await c.ready;
  const lock3 = await call("eye_lock", { seconds: 20 });
  check(/lock/i.test(lock3) && !/refused|QUEUED/.test(lock3), "eye_lock taken for the Calculator drive", lock3.split("\n")[0]);
  osa('tell application "Calculator" to activate', "delay 1",
    'tell application "System Events" to key code 53', "delay 0.5",
    'tell application "System Events" to keystroke "12+34="', "delay 1.5",
    'tell application "System Events" to keystroke "*2="', "delay 1");
  await call("eye_lock", { release: true });
  const { lines: cl, code: cc } = await c.done;
  console.log(cl.map((l) => "     " + l).join("\n"));
  check(has(cl, /announced Calculator "Result, 46"/), "Calculator result announced (attributed-string payload)");
  check(cc === 0 && /Result, 92/.test(cl.at(-1) ?? ""), "--until on an announcement", `exit ${cc}`);
  spawnSync("osascript", ["-e", 'tell application "Calculator" to quit']);
}
await client.close();

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
