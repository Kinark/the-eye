// node test/timer-pill.mjs '<process>' [mode] [x,y] [colStep]
//   mode "find": open the Nook, dump watched glass hosts + text near the widgets, close.
//   mode "drag": open the Nook, hover the timer wheels at x,y (the minutes column), press, drag up/down and
//                sideways, release; records the region and probes every layer near the pill.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync } from "node:fs";

const [proc = "NOOTCH! AppStore", mode = "find", at = "0,0", clickAt = ""] = process.argv.slice(2);
const [px, py] = at.split(",").map(Number);
const client = new Client({ name: "timer-pill", version: "1" });
await client.connect(new StdioClientTransport({ command: "node", args: [new URL("../src/index.ts", import.meta.url).pathname] }));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 300_000 });
  return (r.isError ? "ERROR: " : "") + r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
};
const log = (h, s) => console.log(`== ${h}\n${s}`);
let probeFile = "";
const live = () => { try { return JSON.parse(readFileSync(probeFile + ".live.json", "utf8")); } catch { return null; } };
let capturing = false;

try {
  const st = await call("eye_probe", { process: proc, label: "timer-pill", max_seconds: 90,
    watch: ["PublicGlassHostView", "PublicGlassRectHostView", "NSGlassEffectView", "DropAreaView", "ScrollWheelNSView"] });
  log("probe", st);
  if (st.startsWith("ERROR")) throw new Error("probe did not start");
  probeFile = st.match(/→ (\S+\.ndjson)/)[1];
  log("lock", await call("eye_lock", { seconds: 90, strict: true }));
  const nookOpen = "pr && pr.watched.some(w => w.rect && w.label.includes('PublicGlassHostView') && w.rect[3] > 120)";
  log("open", await call("eye_act", { label: "open", steps: [
    { op: "move", x: 756, y: 14, ms: 250 }, { op: "wait", ms: 500 },
    { op: "click", on: "DropAreaView" }, { op: "wait_until", expr: nookOpen, timeout_ms: 2500 }, { op: "wait", ms: 1200 },
  ] }));
  if (clickAt) {
    const [qx, qy] = clickAt.split(",").map(Number);
    log("click", await call("eye_act", { label: "click", steps: [
      { op: "move", x: qx, y: qy, ms: 200 }, { op: "wait", ms: 200 }, { op: "click", x: qx, y: qy }, { op: "wait", ms: 1200 },
    ] }));
  }
  if (mode === "find") {
    const l = live();
    log("watched", (l?.watched ?? []).filter((e) => e.rect && !e.gone)
      .map((e) => `#${e.id} ${e.label.trim().slice(0, 70)} ${JSON.stringify(e.rect.map((n) => Math.round(n)))}`).join("\n"));
  } else {
    log("hover", await call("eye_act", { label: "hover", steps: [
      { op: "move", x: px, y: py, ms: 300 }, { op: "wait", ms: 900 } ] }));
    log("watched", (live()?.watched ?? []).filter((e) => e.rect && !e.gone)
      .map((e) => `#${e.id} ${e.label.trim().slice(0, 70)} ${JSON.stringify(e.rect.map((n) => Math.round(n)))}`).join("\n"));
    log("probe A stop", (await call("eye_stop", { top: 3 })).split("\n").slice(0, 3).join("\n"));
    const st2 = await call("eye_probe", { process: proc, label: "timer-pill-near", max_seconds: 60, full_walk: true,
      rect: { x: px - 90, y: py - 50, w: 180, h: 100 }, watch: ["PublicGlassRectHostView", "NSGlassEffectView"] });
    log("probe B", st2);
    probeFile = st2.match(/→ (\S+\.ndjson)/)[1];
    log("capture", await call("eye_record", { rect: { x: Math.round(px - 90), y: Math.round(py - 50), w: 180, h: 100 },
      label: "timer-pill", max_seconds: 40, keyframe_ms: 25, cursor: false }));
    capturing = true;
    log("drag", await call("eye_act", { label: "drag", steps: [
      { op: "down", x: px, y: py, button: "left" }, { op: "wait", ms: 400 },
      { op: "move", x: px, y: py - 25, ms: 500 }, { op: "wait", ms: 1200 },
      { op: "move", x: px, y: py + 25, ms: 700 }, { op: "wait", ms: 1200 },
      { op: "move", x: px + 20, y: py, ms: 500 }, { op: "wait", ms: 800 },
      { op: "move", x: px, y: py, ms: 300 }, { op: "up", button: "left" }, { op: "wait", ms: 1500 },
    ] }));
  }
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
