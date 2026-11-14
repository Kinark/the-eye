// node test/feel-e2e.mjs — what moved it, read off a real screen.
// Builds test/fixtures/springy.swift (a bar driven by a known CASpringAnimation, a critically damped one, an
// easeInEaseOut and a hand-rolled per-frame lerp; a puck that slides without changing size, on a spring and on an
// easeOut; a tile that grows and shrinks in both dimensions at once), presses each button by name with eye_drive and checks that
// the reply names the engine and recovers its numbers from the captured frames alone: no probe, no source.
// TAKES THE REAL INPUT LOCK for a few seconds per press (a small pill; Esc ×6 releases).
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
const client = new Client({ name: "feel-e2e", version: "1" });
await client.connect(new StdioClientTransport({ command: "node", args: [join(ROOT, "src", "index.ts")] }));
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
  const t = r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  console.log(`\n=== ${name} ${JSON.stringify(args)}${r.isError ? "  [ERROR]" : ""}\n${t}`);
  return { t, err: !!r.isError };
};
let failed = 0, grows = 0;
const want = (what, ok) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failed++; };
const num = (t, re) => { const m = t.match(re); return m ? Number(m[1]) : NaN; };
const near = (x, truth, tol) => Math.abs(x - truth) <= tol;

try {
  await new Promise((r) => setTimeout(r, 1500));
  const only = process.env.FEEL_ONLY?.split(",");
  for (const name of ["Spring", "Smooth", "Ease", "Lerp", "Slide", "Glide", "Grow", "Grow", "Drop", "Fade"].filter((n) => !only || only.includes(n))) {
    // One call: the hand finds the button by its name, presses it, the recording runs on, the session ends.
    const { t } = await call("eye_drive", { app: app.pid, probe: false, wing: `"${name}" tap`, steps: [{ op: "wait", ms: name === "Drop" ? 2600 : 1600 }], end: true });
    want(`pressed the ${name} button`, /● tap at .* on Button/.test(t) && !/WING STOPPED/.test(t));
    const line = t.split("\n").find((l) => /moved by:/.test(l)) ?? "";
    if (name === "Spring") {
      want("Spring: called a spring", /moved by: a SPRING/.test(line));
      want(`Spring: damping ratio ≈ 0.5 (got ${num(line, /damping ratio ([\d.]+)/)})`, near(num(line, /damping ratio ([\d.]+)/), 0.5, 0.06));
      want(`Spring: response ≈ 0.5s (got ${num(line, /response ([\d.]+)s/)})`, near(num(line, /response ([\d.]+)s/), 0.5, 0.05));
      want("Spring: the overshoot was seen", /overshot (1[0-9]|2[0-2])% past its target/.test(t));
    } else if (name === "Smooth") {
      want("Smooth: called a spring", /a SPRING/.test(t));
      const l = t.split("\n").find((x) => /a SPRING/.test(x)) ?? "";
      want(`Smooth: damping ratio ≈ 1 (got ${num(l, /damping ratio ([\d.]+)/)})`, near(num(l, /damping ratio ([\d.]+)/), 1, 0.12));
      want(`Smooth: response ≈ 0.4s (got ${num(l, /response ([\d.]+)s/)})`, near(num(l, /response ([\d.]+)s/), 0.4, 0.05));
    } else if (name === "Ease") {
      want("Ease: called a timing curve", /moved by: a TIMING CURVE/.test(line));
      want("Ease: named easeInOut", /easeInOut/.test(line));
      want(`Ease: ≈ 350ms (got ${num(line, /over (\d+)ms/)})`, near(num(line, /over (\d+)ms/), 350, 30));
    } else if (name === "Slide") {
      want("Slide: seen as travel, not as a size change", /what moved travelled (3[89]\d|4[01]\d)pt right/.test(t));
      want("Slide: called a spring", /moved by: a SPRING/.test(line));
      want(`Slide: damping ratio ≈ 0.6 (got ${num(line, /damping ratio ([\d.]+)/)})`, near(num(line, /damping ratio ([\d.]+)/), 0.6, 0.08));
      want(`Slide: response ≈ 0.45s (got ${num(line, /response ([\d.]+)s/)})`, near(num(line, /response ([\d.]+)s/), 0.45, 0.05));
    } else if (name === "Glide") {
      want("Glide: seen as travel back", /what moved travelled (3[89]\d|4[01]\d)pt left/.test(t));
      want("Glide: called a timing curve, easeOut", /moved by: a TIMING CURVE.*easeOut/.test(line));
      want(`Glide: ≈ 300ms (got ${num(line, /over (\d+)ms/)})`, near(num(line, /over (\d+)ms/), 300, 30));
    } else if (name === "Grow") {
      const back = grows++ > 0;
      want(`Grow ${back ? "back" : "out"}: both dimensions seen`, back ? /what moved shrank (29|30)\dpt×1[34]\dpt → [56]\dpt×[34]\dpt/.test(t) : /what moved grew [56]\dpt×[345]\dpt → (29|30)\dpt×1[34]\dpt/.test(t));
      want(`Grow ${back ? "back" : "out"}: called a spring`, /moved by: a SPRING/.test(line));
      want(`Grow ${back ? "back" : "out"}: damping ratio ≈ 0.7 (got ${num(line, /damping ratio ([\d.]+)/)})`, near(num(line, /damping ratio ([\d.]+)/), 0.7, 0.1));
      want(`Grow ${back ? "back" : "out"}: response ≈ 0.4s (got ${num(line, /response ([\d.]+)s/)})`, near(num(line, /response ([\d.]+)s/), 0.4, 0.06));
    } else if (name === "Drop") {
      want("Drop: seen as a fall", /what moved travelled (2[3-6]\d)pt down/.test(t));
      want("Drop: called a bounce", /moved by: a BOUNCE/.test(line));
      want(`Drop: keeps ≈ 0.6 of its speed (got ${num(line, /keeping ([\d.]+) of its speed/)})`, near(num(line, /keeping ([\d.]+) of its speed/), 0.6, 0.05));
      want(`Drop: lands after ≈ 400ms (got ${num(line, /lands after (\d+)ms/)})`, near(num(line, /lands after (\d+)ms/), 400, 30));
      want(`Drop: gravity ≈ 3125pt/s² (got ${num(line, /acceleration \((\d+)pt/)})`, near(num(line, /acceleration \((\d+)pt/), 3125, 350));
    } else if (name === "Fade") {
      want("Fade: nothing is said to have travelled", !/what moved travelled/.test(t));
      want("Fade: called a timing curve, easeInOut", /moved by: a TIMING CURVE.*easeInOut/.test(line));
      want(`Fade: ≈ 400ms (got ${num(line, /over (\d+)ms/)})`, near(num(line, /over (\d+)ms/), 400, 40));
    } else {
      want("Lerp: called a per-frame lerp", /PER-FRAME LERP/.test(t));
      const l = t.split("\n").find((x) => /PER-FRAME LERP/.test(x)) ?? "";
      want(`Lerp: factor ≈ 0.12 (got ${num(l, /× ([\d.]+) each frame/)})`, near(num(l, /× ([\d.]+) each frame/), 0.12, 0.03));
    }
  }
} catch (e) { console.error(e); failed++; }
finally { app.kill("SIGKILL"); await client.close(); }
console.log(failed ? `\n${failed} FAILED` : "\nall checks pass");
process.exit(failed ? 1 : 0);
