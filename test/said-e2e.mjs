// node test/said-e2e.mjs — what the app SAID, on the clock of what it showed.
// Builds test/fixtures/springy.swift, whose every button also tells accessibility two things without drawing them:
// its status text becomes "<name> started" inside the button's action, and "<name> at 200" is announced 200ms later.
// Presses Ease (a 350ms animation) with eye_act and checks that the reply carries both, timed against the click and
// placed inside the motion; that events:false leaves them out; and that the explain view lists them.
// TAKES THE REAL INPUT LOCK for a few seconds per press (countdown, orange overlay; Esc ×6 releases).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "eye-springy-"));
const appDir = join(dir, "Springy.app"), exe = join(appDir, "Contents", "MacOS", "Springy");
mkdirSync(join(appDir, "Contents", "MacOS"), { recursive: true });
writeFileSync(join(appDir, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>the-eye.fixture.springy</string><key>CFBundleName</key><string>Springy</string>
<key>CFBundleExecutable</key><string>Springy</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
const sh = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: "utf8" }); if (r.status !== 0) { console.error(`${cmd} failed:\n${r.stderr}`); process.exit(2); } };
sh("swiftc", ["-Onone", "-g", join(ROOT, "test", "fixtures", "springy.swift"), "-o", exe]);
sh("codesign", ["-f", "-s", "-", appDir]);

const app = spawn(exe, [], { stdio: "ignore" });
const client = new Client({ name: "said-e2e", version: "1" });
await client.connect(new StdioClientTransport({ command: "node", args: [join(ROOT, "src", "index.ts")] }));
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
  const t = r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  console.log(`\n=== ${name} ${JSON.stringify(args)}${r.isError ? "  [ERROR]" : ""}\n${t}`);
  return { t, err: !!r.isError };
};
let failed = 0;
const want = (what, ok) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failed++; };
const num = (t, re) => { const m = t.match(re); return m ? Number(m[1]) : NaN; };
const near = (x, truth, tol) => Math.abs(x - truth) <= tol;

try {
  await new Promise((r) => setTimeout(r, 1500));
  const tree = await call("eye_inspect", { process: String(app.pid) });
  const m = tree.t.match(/Button "Ease"[^\[]*\[(-?\d+),(-?\d+) (\d+)×(\d+)\]/);
  want("found the Ease button", !!m);
  const x = Number(m[1]) + Number(m[3]) / 2, y = Number(m[2]) + Number(m[4]) / 2;
  const press = (extra = {}) => call("eye_act", { target_process: app.pid, front: true, ...extra, steps: [{ op: "click", x, y, note: "Ease" }, { op: "wait", ms: 1600 }] });

  const { t } = await press();
  const L = t.split("\n");
  const started = L.find((l) => /^\s+[\d.]+s value-changed .*"Ease started"/.test(l)) ?? "";
  const at200 = L.find((l) => /^\s+[\d.]+s announced "Ease at 200"/.test(l)) ?? "";
  const seen = num(t, /answered ([\d.]+)ms after click/);
  want("the section is there", /what the app told accessibility \(same clock\):/.test(t));
  want(`the status text is reported: ${started.trim()}`, !!started);
  const s0 = num(started, /([\d.]+)ms after click "Ease"/), a0 = num(at200, /([\d.]+)ms after click "Ease"/);
  want(`…and timed against the click (got ${s0}ms; the action runs on mouse-up)`, s0 >= 0 && s0 <= 120);
  want(`the announcement is reported: ${at200.trim()}`, !!at200);
  want(`…200ms after the status text (got ${(a0 - s0).toFixed(1)}ms)`, near(a0 - s0, 200, 25));
  const pct = num(at200, /(\d+)% into the motion/);
  want(`…and placed inside the motion (got ${pct}%; 200ms into 350ms, less what it took to appear)`, pct >= 35 && pct <= 75);
  const word = L.find((l) => /told accessibility .* after the step|the app knew first|the screen changed first/.test(l)) ?? "";
  want(`the response line says who was first: ${word.trim()}`, !!word && /Ease started/.test(word));
  want(`…consistent with the screen's own answer (${seen}ms)`, Number.isFinite(seen));

  const ex = await call("eye_report", { view: "explain" });
  want("explain lists them with the cursor", /## what Springy told accessibility/.test(ex.t) && /Ease at 200.*cursor \(/.test(ex.t));
  want("explain counts them as a source", /accessibility events [1-9]/.test(ex.t));

  const off = await press({ events: false });
  want("events:false: nothing is listened to", !/told accessibility/.test(off.t));
  want("events:false: the motion is still read", /moved by: a TIMING CURVE/.test(off.t));
  const fps = (s) => num(s, /([\d.]+) fps of 120/);
  console.log(`info fps with the observer ${fps(t)}, without ${fps(off.t)}`);
} catch (e) { console.error(e); failed++; }
finally { app.kill("SIGKILL"); await client.close(); }
console.log(failed ? `\n${failed} FAILED` : "\nall checks pass");
process.exit(failed ? 1 : 0);
