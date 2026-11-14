// node test/probe-feel-e2e.mjs — what moved it, read from INSIDE the app.
// Builds test/fixtures/springy.swift as a debuggable app, presses each button by name with eye_drive (the probe goes in by
// itself) and checks that the probe's part of the reply names, per layer: the animation the code DECLARED (CASpringAnimation mass /
// stiffness / damping, CABasicAnimation duration + timing function), the engine fitted to the exact presentation
// values, and that the two agree. The Lerp and Drop buttons declare nothing (display-link driven): only the fit speaks.
// TAKES THE REAL INPUT LOCK for a few seconds per press (a small pill; Esc ×6 releases).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "eye-springy-probe-"));
const appDir = join(dir, "Springy.app"), exe = join(appDir, "Contents", "MacOS", "Springy"), ent = join(dir, "debug.entitlements");
mkdirSync(join(appDir, "Contents", "MacOS"), { recursive: true });
writeFileSync(join(appDir, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>the-eye.fixture.springy</string><key>CFBundleName</key><string>Springy</string>
<key>CFBundleExecutable</key><string>Springy</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
writeFileSync(ent, `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>com.apple.security.get-task-allow</key><true/></dict></plist>`);
const sh = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: "utf8" }); if (r.status !== 0) { console.error(`${cmd} failed:\n${r.stderr}`); process.exit(2); } };
sh("swiftc", ["-Onone", "-g", join(ROOT, "test", "fixtures", "springy.swift"), "-o", exe]);
sh("codesign", ["-f", "-s", "-", "--entitlements", ent, appDir]);

const app = spawn(exe, [], { stdio: "ignore" });
const client = new Client({ name: "probe-feel-e2e", version: "1" });
await client.connect(new StdioClientTransport({ command: "node", args: [join(ROOT, "src", "index.ts")] }));
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 300_000 });
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
  // One press per engine, one session each (the probe goes in by itself, once): every report then holds one motion.
  let first = true;
  const press = async (name, wait) => {
    const r = await call("eye_drive", { app: app.pid, wing: `"${name}" tap`, steps: [{ op: "wait", ms: wait }], end: true });
    if (first) { first = false; want("the probe went in by itself", /probe inside Springy/.test(r.t)); }
    want(`pressed the ${name} button`, /● tap at .* on Button/.test(r.t) && !/WING STOPPED/.test(r.t));
    const at = r.t.indexOf("FROM INSIDE THE APP");
    want(`${name}: the reply carries the probe's report`, at >= 0);
    return at >= 0 ? r.t.slice(at) : "";
  };

  let t = await press("Spring", 1600);
  want("Spring: the declared CASpringAnimation is quoted", /declared: CASpringAnimation on bounds\.size\.width/.test(t));
  want(`Spring: declared stiffness ≈ 157.91 (got ${num(t, /declared: CASpringAnimation[^\n]*stiffness ([\d.]+)/)})`, near(num(t, /declared: CASpringAnimation[^\n]*stiffness ([\d.]+)/), 157.91, 0.02));
  want(`Spring: declared damping ≈ 12.57 (got ${num(t, /declared: CASpringAnimation[^\n]*damping ([\d.]+) =/)})`, near(num(t, /declared: CASpringAnimation[^\n]*damping ([\d.]+) =/), 12.57, 0.02));
  want(`Spring: fitted damping ratio ≈ 0.5 (got ${num(t, /moved by: a SPRING, damping ratio ([\d.]+)/)})`, near(num(t, /moved by: a SPRING, damping ratio ([\d.]+)/), 0.5, 0.02));
  want(`Spring: fitted response ≈ 0.5s (got ${num(t, /moved by: a SPRING[^\n]*response ([\d.]+)s/)})`, near(num(t, /moved by: a SPRING[^\n]*response ([\d.]+)s/), 0.5, 0.02));
  want("Spring: ran as declared", /✓ it ran as declared/.test(t));

  t = await press("Smooth", 1600);
  want(`Smooth: declared damping ratio 1 (got ${num(t, /declared: CASpringAnimation[^\n]*damping ratio ([\d.]+)/)})`, near(num(t, /declared: CASpringAnimation[^\n]*damping ratio ([\d.]+)/), 1, 0.01));
  want("Smooth: ran as declared", /✓ it ran as declared/.test(t));

  t = await press("Ease", 1600);
  want("Ease: declared 0.35s easeInOut", /declared: CABasicAnimation on bounds\.size\.width[^\n]*: 0\.35s, easeInOut/.test(t));
  want(`Ease: fitted ≈ 350ms (got ${num(t, /TIMING CURVE over (\d+)ms/)})`, near(num(t, /TIMING CURVE over (\d+)ms/), 350, 12));
  want("Ease: ran as declared", /✓ it ran as declared/.test(t));

  t = await press("Lerp", 1600);
  want("Lerp: nothing declared (the app drives it itself)", !/declared:/.test(t));
  want(`Lerp: fitted factor ≈ 0.12 (got ${num(t, /× ([\d.]+) each frame/)})`, near(num(t, /× ([\d.]+) each frame/), 0.12, 0.01));

  t = await press("Slide", 1600);
  want("Slide: declared spring on position.x", /declared: CASpringAnimation on position\.x/.test(t));
  want(`Slide: fitted damping ratio ≈ 0.6 (got ${num(t, /moved by: a SPRING, damping ratio ([\d.]+)/)})`, near(num(t, /moved by: a SPRING, damping ratio ([\d.]+)/), 0.6, 0.02));
  want("Slide: read from x, ran as declared", /layer's own x inside the app/.test(t) && /✓ it ran as declared/.test(t));

  t = await press("Drop", 2600);
  want("Drop: nothing declared", !/declared:/.test(t));
  want(`Drop: a bounce keeping ≈ 0.6 (got ${num(t, /keeping ([\d.]+) of its speed/)})`, /a BOUNCE/.test(t) && near(num(t, /keeping ([\d.]+) of its speed/), 0.6, 0.02));
  want(`Drop: gravity ≈ 3125pt/s² (got ${num(t, /acceleration \((\d+)pt/)})`, near(num(t, /acceleration \((\d+)pt/), 3125, 100));

  t = await press("Fade", 1600);
  want("Fade: declared 0.4s easeInOut on opacity", /declared: CABasicAnimation on opacity[^\n]*: 0\.4s, easeInOut/.test(t));
  want("Fade: read from the layer's opacity", /layer's own opacity inside the app/.test(t));
  want(`Fade: fitted ≈ 400ms (got ${num(t, /TIMING CURVE over (\d+)ms/)})`, near(num(t, /TIMING CURVE over (\d+)ms/), 400, 12));
  want("Fade: ran as declared", /✓ it ran as declared/.test(t));
} catch (e) { console.error(e); failed++; }
finally { app.kill("SIGKILL"); await client.close(); }
console.log(failed ? `\n${failed} FAILED` : "\nall checks pass");
process.exit(failed ? 1 : 0);
