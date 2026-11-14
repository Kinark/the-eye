// node test/nootch-see.mjs ['<process>'] — the whole reflex layer against the real thing: load the probe into NOOTCH!,
// hover the notch, open the Nook, look at it at rest, close it, and print everything the-eye says unasked: what the
// screen showed (moved by, what a viewer would notice), what the open Nook reads like standing still (text sizes,
// contrast, alignment, corner shape), and from inside the app what each layer did and what its code declared.
// TAKES THE REAL INPUT LOCK for the hover / open / close (Esc ×6 releases).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [proc = "NOOTCH!-Dev"] = process.argv.slice(2);
const client = new Client({ name: "nootch-see", version: "1" });
await client.connect(new StdioClientTransport({ command: "node", args: [new URL("../src/index.ts", import.meta.url).pathname], env: process.env }));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 300_000 });
  return (r.isError ? "ERROR: " : "") + r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
};
const log = (h, s) => console.log(`\n== ${h}\n${s}`);

const status = await call("eye_status");
const d = JSON.parse(status.split("\n")[0]).displays.find((x) => x.main).points;
const cx = d.w / 2; // the notch sits at the top centre of the built-in display
let probing = false;
try {
  const st = await call("eye_probe", { process: proc, label: "nootch-see", max_seconds: 90, watch: ["PublicGlassHostView", "DropAreaView"] });
  log("probe", st);
  probing = !st.startsWith("ERROR");
  log("hover", await call("eye_act", { target_process: proc, label: "hover", steps: [
    { op: "move", x: cx, y: 500, ms: 100 }, { op: "wait", ms: 300 }, { op: "move", x: cx, y: 14, ms: 250 },
    { op: "move", x: cx + 8, y: 16, ms: 120 }, { op: "move", x: cx, y: 14, ms: 120 }, { op: "wait", ms: 1400 },
  ] }));
  log("open", await call("eye_act", { target_process: proc, label: "open", steps: [
    { op: "click", x: cx, y: 14 }, { op: "wait", ms: 1800 },
  ] }));
  log("at rest, open", await call("eye_snapshot", { rect: { x: Math.round(cx - 400), y: 0, w: 800, h: 320 }, measure: true }));
  log("close", await call("eye_act", { target_process: proc, label: "close", steps: [
    { op: "move", x: cx, y: 620, ms: 300 }, { op: "wait", ms: 1800 },
  ] }));
} catch (e) {
  log("FAILED", e.message);
} finally {
  log("unlock", await call("eye_lock", { release: true }));
  if (probing) log("probe report", await call("eye_stop", { top: 14 }));
  await client.close();
}
