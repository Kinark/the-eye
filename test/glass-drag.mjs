// node test/glass-drag.mjs '<process>' [buttonIndex] — open the Nook, pick a glass button from the probe data, then
// record ONLY that button (keyframes every 25ms) while pressing, dragging sideways, holding, and releasing it.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync } from "node:fs";

const [proc = "NOOTCH! AppStore", near = "1054,143"] = process.argv.slice(2);
const [nx, ny] = near.split(",").map(Number);
const client = new Client({ name: "glass-drag", version: "1" });
await client.connect(new StdioClientTransport({ command: "node", args: [new URL("../src/index.ts", import.meta.url).pathname] }));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 300_000 });
  return (r.isError ? "ERROR: " : "") + r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (h, s) => {
  console.log(`== ${h}\n${s}`);
  if (/^STOPPED/m.test(s) && h !== "release") throw new Error(`${h} stopped`);
};
let probeFile = "";
const live = () => { try { return JSON.parse(readFileSync(probeFile + ".live.json", "utf8")); } catch { return null; } };
let capturing = false;

try {
  const st = await call("eye_probe", { process: proc, label: "glass-drag", max_seconds: 90,
    watch: ["PublicGlassHostView", "NSGlassEffectView", "CABackdropLayer", "DropAreaView"] });
  log("probe", st);
  if (st.startsWith("ERROR")) throw new Error("probe did not start");
  probeFile = st.match(/→ (\S+\.ndjson)/)[1];
  log("lock", await call("eye_lock", { seconds: 90 }));

  const nookOpen = "pr && pr.watched.some(w => w.rect && w.label.includes('PublicGlassHostView') && w.rect[3] > 120)";
  log("open", await call("eye_act", { label: "open", steps: [
    { op: "move", x: 756, y: 14, ms: 250 }, { op: "wait", ms: 500 },
    { op: "click", on: "DropAreaView" }, { op: "wait_until", expr: nookOpen, timeout_ms: 2500 }, { op: "wait", ms: 1200 },
  ] }));

  const l = live();
  const small = (e) => e.rect && !e.gone && e.rect[3] > 14 && e.rect[3] < 190 && e.rect[2] > 14 && e.rect[2] < 200;
  const of = (k) => (l?.watched ?? []).filter((e) => small(e) && e.label.includes(k));
  const hosts = of("PublicGlassHostView").length ? of("PublicGlassHostView") : of("CABackdropLayer");
  log("glass hosts", (l?.watched ?? []).map((e) => `#${e.id} ${e.label.trim().slice(0, 60)} ${JSON.stringify(e.rect)} shape ${JSON.stringify(e.shape ?? null)}`).join("\n"));
  if (!hosts.length) throw new Error("no glass button host found");
  const dist = (e) => Math.hypot(e.rect[0] + e.rect[2] / 2 - nx, e.rect[1] + e.rect[3] / 2 - ny);
  const b = hosts.sort((a, c) => dist(a) - dist(c))[0];
  const [hx, hy, hw, hh] = b.rect;
  const cx = hx + hw / 2, cy = hy + hh / 2;
  log("target", `#${b.id} host ${JSON.stringify(b.rect)} centre ${cx.toFixed(1)},${cy.toFixed(1)}`);

  const m = 30;
  // Second probe: EVERY layer near the button (full walk, rect-limited), so the report shows what moved and what didn't.
  log("probe A stop", (await call("eye_stop", { top: 3 })).split("\n").slice(0, 3).join("\n"));
  const st2 = await call("eye_probe", { process: proc, label: "glass-drag-near", max_seconds: 60, full_walk: true,
    rect: { x: hx - 40, y: hy - 40, w: hw + 80, h: hh + 80 }, watch: ["CABackdropLayer", "PublicGlassHostView"] });
  log("probe B", st2);
  probeFile = st2.match(/→ (\S+\.ndjson)/)[1];
  log("capture", await call("eye_record", { rect: { x: Math.round(hx - m), y: Math.max(0, Math.round(hy - m)), w: Math.round(hw + 2 * m), h: Math.round(hh + 2 * m) },
    label: "glass-drag", max_seconds: 40, keyframe_ms: 25, cursor: false }));
  capturing = true;
  log("status", await call("eye_status"));

  log("press-drag", await call("eye_act", { label: "drag", steps: [
    { op: "move", x: cx, y: cy, ms: 150 }, { op: "wait", ms: 400 }, { op: "down", x: cx, y: cy, button: "left" }, { op: "wait", ms: 500 },
    { op: "move", x: cx + 30, y: cy, ms: 600 }, { op: "wait", ms: 1500 },
    { op: "move", x: cx - 30, y: cy, ms: 900 }, { op: "wait", ms: 1500 },
    { op: "move", x: cx, y: cy, ms: 500 }, { op: "up", button: "left" }, { op: "wait", ms: 1500 },
  ] }));
} catch (e) {
  log("FAILED", e.message);
} finally {
  log("release", await call("eye_act", { lock: false, steps: [{ op: "up", button: "left" }] }));
  log("close", await call("eye_act", { lock: false, steps: [{ op: "move", x: 756, y: 600, ms: 250 }] }));
  log("unlock", await call("eye_lock", { release: true }));
  let csv;
  if (capturing) {
    const cap = await call("eye_stop");
    csv = cap.match(/csv: (\S+)/)?.[1];
    log("capture report", cap);
  }
  log("probe report", await call("eye_stop", { top: 30, capture_csv: csv }));
  await client.close();
}
