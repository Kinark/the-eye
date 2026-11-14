// node test/why-e2e.mjs [jank_ms] — the whole loop on a real screen: act, see, and be told why.
// Builds test/fixtures/janky.swift as a debuggable app (ad-hoc signed, get-task-allow) and presses its button by
// name in ONE eye_drive call (the probe goes in by itself, the window is recorded, the session ends) and checks
// that the reply names the freeze AND the function that blocked the main thread.
// TAKES THE REAL INPUT LOCK for a few seconds (a small pill; Esc ×6 releases).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
const AS_ROOT = process.env.THE_EYE_ROOT !== "0" && spawnSync("/usr/bin/sudo", ["-n", "-l", "/usr/sbin/dtrace"], { stdio: "ignore" }).status === 0;
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const jank = process.argv[2] ?? "140";
const dir = mkdtempSync(join(tmpdir(), "eye-janky-"));
const appDir = join(dir, "Janky.app"), exe = join(appDir, "Contents", "MacOS", "Janky");
mkdirSync(join(appDir, "Contents", "MacOS"), { recursive: true });
writeFileSync(join(appDir, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>the-eye.fixture.janky</string><key>CFBundleName</key><string>Janky</string>
<key>CFBundleExecutable</key><string>Janky</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
const ent = join(dir, "ent.plist");
writeFileSync(ent, `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>com.apple.security.get-task-allow</key><true/></dict></plist>`);
const sh = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: "utf8" }); if (r.status !== 0) { console.error(`${cmd} failed:\n${r.stderr}`); process.exit(2); } };
sh("swiftc", ["-Onone", "-g", join(ROOT, "test", "fixtures", "janky.swift"), "-o", exe]);
sh("codesign", ["-f", "-s", "-", "--entitlements", ent, appDir]);

const app = spawn(exe, [], { stdio: "ignore", env: { ...process.env, JANK_MS: jank } });
const client = new Client({ name: "why-e2e", version: "1" });
await client.connect(new StdioClientTransport({ command: "node", args: [join(ROOT, "src", "index.ts")], env: process.env }));
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
  const t = r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  console.log(`\n=== ${name} ${JSON.stringify(args)}${r.isError ? "  [ERROR]" : ""}\n${t}`);
  return { t, err: !!r.isError };
};
let failed = 0;
const want = (what, ok) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failed++; };
try {
  await new Promise((r) => setTimeout(r, 1500));
  // One call: the probe goes in by itself, the hand finds Go by its name, the session ends with the report.
  const act = await call("eye_drive", { app: app.pid, wing: '"Go" tap', steps: [{ op: "wait", ms: 1200 }], end: true });
  want("the probe went in by itself", /probe inside Janky/.test(act.t));
  want("the press landed on the button", /● tap at .* on Button "Go"/.test(act.t) && !/WING STOPPED/.test(act.t));
  want("the session watched the window by itself", /WHAT IT LOOKED LIKE/.test(act.t));
  if (Number(jank) >= 100) {
    want("the freeze was noticed", /(FROZE|HUNG) \d/.test(act.t));
    want("the cause is the main thread", /main thread was blocked/.test(act.t));
    want("the culprit is named", /Model\.reload/.test(act.t));
    // Without the probe and without root: the same freeze, read from what AppKit and Core Animation say of themselves.
    const [, quiet, by] = act.t.match(/the app was late: it committed nothing to Core Animation for ([\d.]+)ms \((dtrace|signposts)\)/) ?? [];
    want(`${by} agrees without the probe: no commit for ${quiet}ms of the 150ms block`, Math.abs(Number(quiet) - 150) <= 25 && by === (AS_ROOT ? "dtrace" : "signposts"));
    const cycle = Number(act.t.match(/AppKit's update cycle ran ([\d.]+)ms and AppKit flagged it a stall/)?.[1]);
    want(`AppKit's own signposts name the stalled update cycle (${cycle}ms)`, Math.abs(cycle - 150) <= 25);
    want("the time is placed outside event handling and the commit", /so it went to the app's own per-frame code/.test(act.t));
    want("the window server's frames are timed", /the window server: rendered each frame in [\d.]+ms/.test(act.t));
    want("the app's own energy is priced against rest", /the app's own energy while moving: \d+ mW[\s\S]*the app's own energy at rest/.test(act.t));
    // As root (only when sudo runs dtrace without a password): which of the display's frames were this app's.
    if (AS_ROOT) {
      const [, mine, wait] = act.t.match(/this app's share: (\d+) of those frames carried a change of its windows, each on the display ([\d.]+)ms after/) ?? [];
      want(`the app's own share of the display's frames is counted (${mine} frames, ${wait}ms to the display)`, Number(mine) > 10 && Number(wait) < 17);
      want("commits and display frames are counted for the motion", /under the pixels[\s\S]*the app committed \d+×[\s\S]*the display got \d+ frames/.test(act.t));
      want("moving is priced against rest", /cost while moving: app \d+ ms\/s CPU[\s\S]*cost at rest/.test(act.t));
    } else console.log("skip root readings (sudo -n dtrace is not allowed here)");
  } else want("a clean run has no freeze and no blocked main thread", /LOOKED (SMOOTH|MOSTLY SMOOTH)/.test(act.t) && !/FROZE|HUNG|main thread was blocked/.test(act.t));
  want("the press was timed", /answered [\d.]+ms after click "Go"/.test(act.t) || /first visible change/.test(act.t));
  if (Number(jank) >= 100) want("the probe report lists the stall", /FROM INSIDE THE APP[\s\S]*main-thread stalls[\s\S]*Model\.reload/.test(act.t));
  const ex = await call("eye_report", { view: "explain" });
  if (Number(jank) >= 100) want("explain (default: the last run) ties the gap to the stall", /main thread was blocked/.test(ex.t));
} catch (e) { console.error(e); failed++; }
finally { app.kill("SIGKILL"); await client.close(); }
console.log(failed ? `\n${failed} FAILED` : "\nall checks pass");
process.exit(failed ? 1 : 0);
