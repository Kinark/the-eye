// node test/still-e2e.mjs — what a window that holds still says, read off a real screen.
// Builds test/fixtures/still.swift (text of known sizes and colours, boxes with a 2pt misalignment, uneven gaps, an
// overlap, a label running off the window, and the four corner shapes), looks at it once with eye_snapshot {app} and with
// eye_snapshot, and checks that the reply carries the measurements nobody asked for.
// Holds the real input for a fraction of a second ("Just a sec…").
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "eye-still-"));
const appDir = join(dir, "Still.app"), exe = join(appDir, "Contents", "MacOS", "Still");
mkdirSync(join(appDir, "Contents", "MacOS"), { recursive: true });
writeFileSync(join(appDir, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>the-eye.fixture.still</string><key>CFBundleName</key><string>Still</string>
<key>CFBundleExecutable</key><string>Still</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
const sh = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: "utf8" }); if (r.status !== 0) { console.error(`${cmd} failed:\n${r.stderr}`); process.exit(2); } };
sh("swiftc", ["-Onone", join(ROOT, "test", "fixtures", "still.swift"), "-o", exe]);
sh("codesign", ["-f", "-s", "-", appDir]);

const app = spawn(exe, [], { stdio: "ignore" });
const client = new Client({ name: "still-e2e", version: "1" });
await client.connect(new StdioClientTransport({ command: "node", args: [join(ROOT, "src", "index.ts")], env: { ...process.env } }));
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 });
  const t = r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  console.log(`\n=== ${name} ${JSON.stringify(args)}${r.isError ? "  [ERROR]" : ""}\n${t}`);
  return t;
};
let failed = 0;
const want = (what, ok) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failed++; };
const num = (t, re) => { const m = t.match(re); return m ? Number(m[1]) : NaN; };
const near = (x, truth, tol) => Math.abs(x - truth) <= tol;

function check(t, how) {
  const rest = t.slice(t.indexOf("## at rest"));
  want(`${how}: the reading is there, unasked`, t.includes("## at rest"));
  want(`${how}: text sizes span 9 to 22pt`, /text: 5 read, ≈(9|10)–22pt/.test(rest));
  want(`${how}: the 9pt caption is called small`, near(num(rest, /small text: ≈([\d.]+)pt "Tiny caption"/), 9, 1));
  want(`${how}: the grey hint is 2.68:1 on white`, near(num(rest, /low contrast: ([\d.]+):1 #9[de]9[de]9[de] on #ffffff "Faint hint"/), 2.68, 0.15));
  want(`${how}: black body text is not called faint`, !/low contrast:.*Body copy/.test(rest));
  want(`${how}: Lower is 2pt off the column`, /almost aligned: "Lower" left edge at x \d+, 2pt off "Upper"/.test(rest));
  want(`${how}: the row's gaps are 12, 12, 15`, /uneven gaps: "One" · "Two" · "Three" · "Four" \(a row\): gaps 12, 12, 15pt/.test(rest));
  want(`${how}: the evenly spaced shapes are not called uneven`, !/uneven gaps:.*Circular/.test(rest));
  want(`${how}: Back and Front share 10×20pt`, /overlapping: "Back" and "Front" share 10×20pt/.test(rest));
  want(`${how}: the label runs 28pt off the right edge`, /cut off: "Runs off the edge" runs 28pt past the window's right edge/.test(rest));
  want(`${how}: the arc is an 18pt circular arc`, near(num(rest, /r≈([\d.]+) circular arc — "Circular"/), 18, 1));
  want(`${how}: the squircle is continuous, about 18pt`, near(num(rest, /r≈([\d.]+) continuous — "Continuous"/), 18, 2.5));
  want(`${how}: the pill is a capsule`, /capsule — "Pill"/.test(rest));
  want(`${how}: the boxes are square`, /square — "One", "Two", "Three" \+6/.test(rest));
}

try {
  await new Promise((r) => setTimeout(r, 1500));
  const g = await call("eye_snapshot", { app: "Still", return_image: false });
  check(g, "glance");
  const [, x, y, w, h] = g.match(/\[(\d+),(\d+) (\d+)×(\d+)\]/) ?? [];
  want("glance names the window frame", !!w);
  const s = await call("eye_snapshot", { rect: { x: +x, y: +y, w: +w, h: +h } });
  check(s, "snapshot");
  const off = await call("eye_snapshot", { rect: { x: +x, y: +y, w: +w, h: +h }, measure: false });
  want("measure:false leaves the image alone", !off.includes("## at rest"));
} finally {
  app.kill();
  await client.close();
}
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
