// node test/probe-drive.mjs '<process>' — drive NOOTCH! by itself: open the notch, find a glass button from the
// probe's own layer data, press-drag it, peeking the probe every 0.5s. Physical input is locked (Esc releases).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [proc = "NOOTCH! AppStore"] = process.argv.slice(2);
const client = new Client({ name: "probe-drive", version: "1" });
await client.connect(new StdioClientTransport({ command: "node", args: [new URL("../src/index.ts", import.meta.url).pathname] }));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 300_000 });
  return (r.isError ? "ERROR: " : "") + r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (h, s) => {
  console.log(`== ${h}\n${s}`);
  // eye_act reports a refused/failed step as "STOPPED — …": never carry on after one.
  if (/^STOPPED/m.test(s) && h !== "release") throw new Error(`${h} stopped`);
};

let probeFile = "";
async function peekLoop(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { await sleep(500); log("peek", await call("eye_peek", { max: 6 })); }
}
async function liveJson() {
  const fs = await import("node:fs");
  try { return JSON.parse(fs.readFileSync(probeFile + ".live.json", "utf8")); } catch { return null; }
}

try {
  log("capture", await call("eye_record", { rect: { x: 356, y: 0, w: 800, h: 320 }, label: "drive-capture", max_seconds: 60, cursor: false }));
  const st = await call("eye_probe", { process: proc, label: "drive", max_seconds: 60, watch: ["PublicGlassHostView", "CABackdropLayer", "DropAreaView"] });
  log("probe", st);
  if (st.startsWith("ERROR")) throw new Error("probe did not start");
  probeFile = st.match(/→ (\S+\.ndjson)/)[1];
  log("lock", await call("eye_lock", { seconds: 90, strict: true }));

  // 1. Open: hover, then click if hovering alone doesn't open it.
  log("open", await call("eye_act", { label: "open", steps: [
    { op: "move", x: 756, y: 12, ms: 250 }, { op: "wait", ms: 600 },
  ] }));
  // Hover only gives the small bulge; a click opens the Nook (the notch glass host grows past 120pt tall).
  const nookOpen = "pr && pr.watched.some(w => w.rect && w.label.includes('PublicGlassHostView') && w.rect[3] > 120)";
  log("open-click", await call("eye_act", { label: "open", steps: [
    { op: "click", on: "DropAreaView" },
    { op: "wait_until", expr: nookOpen, timeout_ms: 2500 },
  ] }));
  let live = await liveJson();
  await peekLoop(1500);

  // 2. Find glass buttons (small public-glass hosts) from the probe data.
  live = await liveJson();
  // Glass buttons: public hosts (button box + 20pt warp margin per side) or SwiftUI glass backdrops.
  // The notch's own host is the big one; skip anything wider than 200pt.
  const small = (e) => e.rect && !e.gone && e.rect[3] > 14 && e.rect[3] < 110 && e.rect[2] > 14 && e.rect[2] < 200;
  const hosts = (live?.watched ?? []).filter((e) => small(e) && e.label.includes("PublicGlassHostView"));
  const backdrops = (live?.watched ?? []).filter((e) => small(e) && e.label.includes("CABackdropLayer"));
  const buttons = (hosts.length ? hosts : backdrops).sort((a, b) => b.rect[1] - a.rect[1]);
  log("glass hosts", (live?.watched ?? []).map((e) => `#${e.id} ${JSON.stringify(e.rect)}`).join("\n") || "(none)");
  if (!buttons.length) throw new Error("no glass button found in the probe data");
  // The host includes the warp margin around the button; its centre is the button centre.
  const b = buttons[0];
  const cx = b.rect[0] + b.rect[2] / 2, cy = b.rect[1] + b.rect[3] / 2;
  log("target", `#${b.id} centre ${cx.toFixed(1)},${cy.toFixed(1)}`);

  // 3. Press, drag sideways and back, release — peeking while held.
  log("press", await call("eye_act", { label: "press-drag", steps: [
    { op: "move", on: b.id, ms: 200 }, { op: "wait", ms: 300 }, { op: "down", on: b.id, button: "left" },
    { op: "move", x: cx + 25, y: cy, ms: 500 },
  ] }));
  await peekLoop(1000);
  log("drag back", await call("eye_act", { label: "press-drag", steps: [
    { op: "move", x: cx - 25, y: cy, ms: 700 }, { op: "move", x: cx, y: cy, ms: 400 }, { op: "up", button: "left" },
  ] }));
  await peekLoop(1000);

  // 4. Close: move away.
  log("close", await call("eye_act", { label: "close", steps: [{ op: "move", x: 756, y: 600, ms: 300 }, { op: "wait", ms: 800 }] }));
} catch (e) {
  log("FAILED", e.message);
} finally {
  log("release", await call("eye_act", { lock: false, steps: [{ op: "up", button: "left" }] }));
  log("unlock", await call("eye_lock", { release: true }));
  const cap = await call("eye_stop");
  const csv = cap.match(/csv: (\S+)/)?.[1];
  log("capture report", cap);
  log("probe report", await call("eye_stop", { top: 12, capture_csv: csv, match: ["PublicGlass", "NSGlassEffectView", "CABackdropLayer"] }));
  await client.close();
}
